/*
 * AtsImageCapture.m — Stage media from USB cameras via Image Capture Core.
 *
 * Synchronous C API for Rust (Phase 23.2b). ICDeviceBrowser must run on the
 * main queue (Tauri/AppKit run loop); the caller blocks on a condition from a
 * background thread (spawn_blocking) so the UI stays responsive.
 */

#import <Foundation/Foundation.h>
#import <ImageCaptureCore/ImageCaptureCore.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dispatch/dispatch.h>
#include <string.h>

typedef NS_ENUM(NSInteger, AtsIcaPhase) {
  AtsIcaPhaseBrowsing = 0,
  AtsIcaPhaseOpening,
  AtsIcaPhaseReady,
  AtsIcaPhaseDownloading,
  AtsIcaPhaseDone,
  AtsIcaPhaseFailed,
};

@interface AtsIcaRunner : NSObject <ICDeviceBrowserDelegate, ICCameraDeviceDelegate>
@property(nonatomic, strong) ICDeviceBrowser *browser;
@property(nonatomic, strong) ICCameraDevice *camera;
@property(nonatomic, strong) NSMutableArray<ICCameraDevice *> *seenCameras;
@property(nonatomic, strong) NSString *destDir;
@property(nonatomic, strong) NSString *nameHint;
@property(nonatomic, strong) NSMutableArray<ICCameraFile *> *files;
@property(nonatomic, strong) NSMutableArray<NSString *> *localPaths;
@property(nonatomic, assign) NSUInteger downloadIndex;
@property(nonatomic, assign) AtsIcaPhase phase;
@property(nonatomic, strong) NSString *errorMessage;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) BOOL enumerated;
@property(nonatomic, assign) BOOL openAttempted;
@end

@implementation AtsIcaRunner

- (instancetype)initWithDest:(NSString *)dest hint:(NSString *)hint {
  self = [super init];
  if (self) {
    _destDir = [dest copy];
    _nameHint = [hint copy] ?: @"";
    _files = [NSMutableArray array];
    _localPaths = [NSMutableArray array];
    _seenCameras = [NSMutableArray array];
    _phase = AtsIcaPhaseBrowsing;
    _condition = [[NSCondition alloc] init];
  }
  return self;
}

- (void)failWithMessage:(NSString *)msg {
  if (self.finished) {
    return;
  }
  self.errorMessage = msg;
  self.phase = AtsIcaPhaseFailed;
  [self markFinished];
}

- (void)markFinished {
  [self.condition lock];
  if (!self.finished) {
    self.finished = YES;
    [self.condition broadcast];
  }
  [self.condition unlock];
}

- (BOOL)nameMatches:(NSString *)cameraName {
  NSString *n = [cameraName lowercaseString] ?: @"";
  NSString *h = [self.nameHint lowercaseString] ?: @"";
  if (h.length == 0) {
    return n.length > 0;
  }
  if ([h containsString:@"gopro"] || [h containsString:@"hero"] || [h containsString:@"mtp:gopro"]) {
    return [n containsString:@"gopro"] || [n containsString:@"hero"];
  }
  if ([h containsString:@"dji"] || [h containsString:@"osmo"]) {
    return [n containsString:@"dji"] || [n containsString:@"osmo"];
  }
  if ([h containsString:@"insta"]) {
    return [n containsString:@"insta"];
  }
  return [n containsString:h] || [h containsString:n];
}

- (BOOL)isMediaName:(NSString *)name {
  NSString *lower = [name lowercaseString] ?: @"";
  /* Proxies (.lrv) are not staged; they are deleted with the master on SD clear. */
  NSArray *exts = @[
    @".mp4", @".mov", @".m4v", @".avi", @".mkv", @".insv",
    @".jpg", @".jpeg", @".png", @".heic", @".insp", @".dng", @".raw"
  ];
  for (NSString *e in exts) {
    if ([lower hasSuffix:e]) {
      return YES;
    }
  }
  return NO;
}

- (void)collectFilesFromItems:(NSArray<ICCameraItem *> *)items {
  for (ICCameraItem *item in items) {
    if ([item isKindOfClass:[ICCameraFile class]]) {
      ICCameraFile *file = (ICCameraFile *)item;
      NSString *name = file.name ?: @"";
      if ([self isMediaName:name]) {
        [self.files addObject:file];
      }
    } else if ([item isKindOfClass:[ICCameraFolder class]]) {
      ICCameraFolder *folder = (ICCameraFolder *)item;
      if (folder.contents.count > 0) {
        [self collectFilesFromItems:folder.contents];
      }
    }
  }
}

- (void)startBrowsingOnMain {
  NSAssert([NSThread isMainThread], @"ICDeviceBrowser must start on main thread");
  self.browser = [[ICDeviceBrowser alloc] init];
  self.browser.delegate = self;
  // Cast: header uses a combined mask of type + location bits.
  self.browser.browsedDeviceTypeMask =
      (ICDeviceTypeMask)(ICDeviceTypeMaskCamera | ICDeviceLocationTypeMaskLocal |
                         ICDeviceLocationTypeMaskShared | ICDeviceLocationTypeMaskBonjour);
  [self.browser start];
}

- (void)rememberCamera:(ICDevice *)device {
  if ((device.type & ICDeviceTypeCamera) == 0) {
    return;
  }
  if (![device isKindOfClass:[ICCameraDevice class]]) {
    return;
  }
  ICCameraDevice *cam = (ICCameraDevice *)device;
  for (ICCameraDevice *existing in self.seenCameras) {
    if (existing == cam) {
      return;
    }
  }
  [self.seenCameras addObject:cam];
}

- (void)tryOpenBestCamera {
  if (self.openAttempted || self.finished) {
    return;
  }
  if (self.phase != AtsIcaPhaseBrowsing) {
    return;
  }

  // Merge browser.devices with anything we collected via didAddDevice.
  for (ICDevice *dev in (self.browser.devices ?: @[])) {
    [self rememberCamera:dev];
  }

  if (self.seenCameras.count == 0) {
    // Enumerate can fire before USB cameras appear — keep browsing.
    return;
  }

  ICCameraDevice *chosen = nil;
  NSMutableArray *names = [NSMutableArray array];
  for (ICCameraDevice *cam in self.seenCameras) {
    NSString *nm = cam.name ?: @"(unnamed)";
    [names addObject:nm];
    if ([self nameMatches:nm]) {
      chosen = cam;
      break;
    }
  }
  if (!chosen && self.seenCameras.count == 1) {
    chosen = self.seenCameras.firstObject;
  }
  // If we have cameras but none match the hint, still take the first camera
  // (single GoPro / PTP device is the common case).
  if (!chosen && self.seenCameras.count > 0) {
    chosen = self.seenCameras.firstObject;
  }
  if (!chosen) {
    return;
  }

  self.openAttempted = YES;
  self.camera = chosen;
  self.camera.delegate = self;
  self.phase = AtsIcaPhaseOpening;
  [self.camera requestOpenSession];
}

- (void)failIfStillBrowsing {
  if (self.finished || self.phase != AtsIcaPhaseBrowsing) {
    return;
  }
  NSMutableArray *names = [NSMutableArray array];
  for (ICCameraDevice *cam in self.seenCameras) {
    [names addObject:(cam.name ?: @"(unnamed)")];
  }
  for (ICDevice *dev in (self.browser.devices ?: @[])) {
    if (dev.name) {
      [names addObject:dev.name];
    }
  }
  NSString *joined = names.count ? [names componentsJoinedByString:@", "] : @"(keine)";
  [self failWithMessage:[NSString stringWithFormat:
      @"Keine passende USB-Kamera in Bildübernahme gefunden. Gefunden: %@. Hinweis: %@",
      joined, self.nameHint]];
}

- (void)beginDownloads {
  [self.files removeAllObjects];
  if (self.camera.mediaFiles.count > 0) {
    for (ICCameraItem *item in self.camera.mediaFiles) {
      if ([item isKindOfClass:[ICCameraFile class]]) {
        ICCameraFile *file = (ICCameraFile *)item;
        if ([self isMediaName:file.name ?: @""]) {
          [self.files addObject:file];
        }
      }
    }
  }
  if (self.files.count == 0 && self.camera.contents.count > 0) {
    [self collectFilesFromItems:self.camera.contents];
  }
  if (self.files.count == 0) {
    [self failWithMessage:@"Keine Medien auf der Kamera gefunden."];
    return;
  }

  NSError *err = nil;
  [[NSFileManager defaultManager] createDirectoryAtPath:self.destDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:&err];
  if (err) {
    [self failWithMessage:err.localizedDescription];
    return;
  }

  self.phase = AtsIcaPhaseDownloading;
  self.downloadIndex = 0;
  [self downloadNext];
}

- (NSString *)uniquePathForName:(NSString *)name {
  NSString *path = [self.destDir stringByAppendingPathComponent:name];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    return path;
  }
  NSString *stem = [name stringByDeletingPathExtension];
  NSString *ext = [name pathExtension];
  for (NSUInteger i = 1; i < 10000; i++) {
    NSString *candidate = ext.length
                              ? [NSString stringWithFormat:@"%@_%lu.%@", stem, (unsigned long)i, ext]
                              : [NSString stringWithFormat:@"%@_%lu", stem, (unsigned long)i];
    path = [self.destDir stringByAppendingPathComponent:candidate];
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
      return path;
    }
  }
  return path;
}

- (void)downloadNext {
  if (self.downloadIndex >= self.files.count) {
    self.phase = AtsIcaPhaseDone;
    if (self.camera) {
      [self.camera requestCloseSession];
    }
    if (self.browser) {
      [self.browser stop];
    }
    [self markFinished];
    return;
  }

  ICCameraFile *file = self.files[self.downloadIndex];
  NSString *name = file.name ?: [NSString stringWithFormat:@"media_%lu", (unsigned long)self.downloadIndex];
  NSString *destPath = [self uniquePathForName:name];
  NSString *saveAs = [destPath lastPathComponent];
  NSURL *dirURL = [NSURL fileURLWithPath:self.destDir isDirectory:YES];

  NSDictionary *options = @{
    ICDownloadsDirectoryURL : dirURL,
    ICSaveAsFilename : saveAs,
    ICOverwrite : @YES,
  };

  __weak AtsIcaRunner *weakSelf = self;
  [file requestDownloadWithOptions:options
                 completion:^(NSString *_Nullable filename, NSError *_Nullable error) {
                   AtsIcaRunner *strong = weakSelf;
                   if (!strong) {
                     return;
                   }
                   // Completion may arrive off-main; hop back for ICA continuity.
                   dispatch_async(dispatch_get_main_queue(), ^{
                     if (error) {
                       [strong failWithMessage:[NSString stringWithFormat:
                           @"Download fehlgeschlagen (%@): %@", name, error.localizedDescription]];
                       return;
                     }
                     NSString *outPath = nil;
                     if (filename.length > 0) {
                       if ([filename hasPrefix:@"/"]) {
                         outPath = filename;
                       } else {
                         outPath = [strong.destDir stringByAppendingPathComponent:filename];
                       }
                     }
                     if (!outPath) {
                       outPath = destPath;
                     }
                     if ([[NSFileManager defaultManager] fileExistsAtPath:outPath]) {
                       [strong.localPaths addObject:outPath];
                     } else if ([[NSFileManager defaultManager] fileExistsAtPath:destPath]) {
                       [strong.localPaths addObject:destPath];
                     }
                     strong.downloadIndex += 1;
                     [strong downloadNext];
                   });
                 }];
}

#pragma mark - ICDeviceBrowserDelegate

- (void)deviceBrowser:(ICDeviceBrowser *)browser
         didAddDevice:(ICDevice *)device
           moreComing:(BOOL)moreComing {
  (void)browser;
  [self rememberCamera:device];
  if (!moreComing) {
    [self tryOpenBestCamera];
  }
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser
      didRemoveDevice:(ICDevice *)device
            moreGoing:(BOOL)moreGoing {
  (void)browser;
  (void)device;
  (void)moreGoing;
}

- (void)deviceBrowserDidEnumerateLocalDevices:(ICDeviceBrowser *)browser {
  (void)browser;
  self.enumerated = YES;
  // Do NOT fail if empty — USB/PTP devices often appear after this callback.
  [self tryOpenBestCamera];
  if (self.phase == AtsIcaPhaseBrowsing && self.seenCameras.count == 0) {
    // Give hotplug a moment, then try again.
    __weak AtsIcaRunner *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     AtsIcaRunner *strong = weakSelf;
                     if (!strong || strong.finished) {
                       return;
                     }
                     [strong tryOpenBestCamera];
                   });
  }
}

#pragma mark - ICDeviceDelegate / ICCameraDeviceDelegate

- (void)didRemoveDevice:(ICDevice *)device {
  (void)device;
  if (self.phase != AtsIcaPhaseDone && !self.finished) {
    [self failWithMessage:@"Kamera wurde getrennt."];
  }
}

- (void)device:(ICDevice *)device didOpenSessionWithError:(NSError *)error {
  (void)device;
  if (error) {
    [self failWithMessage:error.localizedDescription];
  }
}

- (void)device:(ICDevice *)device didCloseSessionWithError:(NSError *)error {
  (void)device;
  (void)error;
}

- (void)deviceDidBecomeReadyWithCompleteContentCatalog:(ICCameraDevice *)device {
  (void)device;
  if (self.phase == AtsIcaPhaseOpening || self.phase == AtsIcaPhaseBrowsing) {
    self.phase = AtsIcaPhaseReady;
    [self beginDownloads];
  }
}

- (void)cameraDevice:(ICCameraDevice *)camera didAddItems:(NSArray<ICCameraItem *> *)items {
  (void)camera;
  (void)items;
}

- (void)cameraDevice:(ICCameraDevice *)camera didRemoveItems:(NSArray<ICCameraItem *> *)items {
  (void)camera;
  (void)items;
}

- (void)cameraDevice:(ICCameraDevice *)camera
    didReceiveThumbnail:(CGImageRef)thumbnail
                forItem:(ICCameraItem *)item
                  error:(NSError *)error {
  (void)camera;
  (void)thumbnail;
  (void)item;
  (void)error;
}

- (void)cameraDevice:(ICCameraDevice *)camera
    didReceiveMetadata:(NSDictionary *)metadata
               forItem:(ICCameraItem *)item
                 error:(NSError *)error {
  (void)camera;
  (void)metadata;
  (void)item;
  (void)error;
}

- (void)cameraDevice:(ICCameraDevice *)camera didRenameItems:(NSArray<ICCameraItem *> *)items {
  (void)camera;
  (void)items;
}

- (void)cameraDeviceDidChangeCapability:(ICCameraDevice *)camera {
  (void)camera;
}

- (void)cameraDevice:(ICCameraDevice *)camera didReceivePTPEvent:(NSData *)eventData {
  (void)camera;
  (void)eventData;
}

- (void)deviceDidBecomeReady:(ICDevice *)device {
  (void)device;
}

- (void)device:(ICDevice *)device didReceiveStatusInformation:(NSDictionary *)status {
  (void)device;
  (void)status;
}

- (void)device:(ICDevice *)device didEncounterError:(NSError *)error {
  (void)device;
  if (error && self.phase != AtsIcaPhaseDone && !self.finished) {
    [self failWithMessage:error.localizedDescription];
  }
}

- (void)cameraDevice:(ICCameraDevice *)camera didCompleteDeleteFilesWithError:(NSError *)error {
  (void)camera;
  (void)error;
}

- (void)cameraDeviceDidRemoveAccessRestriction:(ICDevice *)device {
  (void)device;
}

- (void)cameraDeviceDidEnableAccessRestriction:(ICDevice *)device {
  (void)device;
}

@end

static void ats_set_error(char *err_buf, size_t err_len, NSString *msg) {
  if (!err_buf || err_len == 0) {
    return;
  }
  const char *utf8 = msg ? msg.UTF8String : "Unbekannter Fehler";
  if (!utf8) {
    utf8 = "Unbekannter Fehler";
  }
  strncpy(err_buf, utf8, err_len - 1);
  err_buf[err_len - 1] = '\0';
}

/**
 * Stage all media from the best-matching Image Capture camera into dest_dir.
 *
 * @return 0 on success (at least one file), non-zero on failure (err_buf set).
 */
int ats_ica_stage_all(const char *dest_dir_utf8, const char *name_hint_utf8, char *err_buf,
                      size_t err_len) {
  if (!dest_dir_utf8 || !dest_dir_utf8[0]) {
    ats_set_error(err_buf, err_len, @"Kein Zielordner angegeben.");
    return 1;
  }

  @autoreleasepool {
    NSString *dest = [NSString stringWithUTF8String:dest_dir_utf8];
    NSString *hint =
        name_hint_utf8 ? [NSString stringWithUTF8String:name_hint_utf8] : @"";

    AtsIcaRunner *runner = [[AtsIcaRunner alloc] initWithDest:dest hint:hint];

    // Start browser on the AppKit/Tauri main queue — required for ICDeviceBrowser.
    dispatch_async(dispatch_get_main_queue(), ^{
      [runner startBrowsingOnMain];
    });

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:90.0];
    NSDate *browseDeadline = [NSDate dateWithTimeIntervalSinceNow:25.0];

    [runner.condition lock];
    while (!runner.finished && [deadline timeIntervalSinceNow] > 0) {
      [runner.condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
      if (!runner.finished && runner.phase == AtsIcaPhaseBrowsing &&
          [browseDeadline timeIntervalSinceNow] <= 0) {
        [runner.condition unlock];
        dispatch_sync(dispatch_get_main_queue(), ^{
          [runner failIfStillBrowsing];
        });
        [runner.condition lock];
        break;
      }
    }
    if (!runner.finished) {
      [runner.condition unlock];
      dispatch_sync(dispatch_get_main_queue(), ^{
        [runner failWithMessage:@"Timeout beim USB-Kamera-Import (Bildübernahme)."];
      });
      [runner.condition lock];
    }
    [runner.condition unlock];

    // Stop browser on main.
    dispatch_sync(dispatch_get_main_queue(), ^{
      if (runner.browser) {
        [runner.browser stop];
      }
    });

    if (runner.phase != AtsIcaPhaseDone || runner.localPaths.count == 0) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage ?: @"USB-Import über Bildübernahme fehlgeschlagen.");
      return 2;
    }
    return 0;
  }
}
