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
#import <ImageIO/ImageIO.h>
#import <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <string.h>

typedef void (*ats_ica_progress_cb)(unsigned int file_index, unsigned int file_total,
                                    const char *filename_utf8, unsigned long long bytes_done,
                                    unsigned long long bytes_total, void *ctx);
typedef void (*ats_ica_catalog_tick_cb)(void *ctx);
typedef void (*ats_ica_count_progress_cb)(unsigned int current, unsigned int total, void *ctx);

typedef NS_ENUM(NSInteger, AtsIcaPhase) {
  AtsIcaPhaseBrowsing = 0,
  AtsIcaPhaseOpening,
  AtsIcaPhaseReady,
  AtsIcaPhaseDownloading,
  AtsIcaPhaseDeleting,
  AtsIcaPhaseDone,
  AtsIcaPhaseFailed,
};

typedef NS_ENUM(NSInteger, AtsIcaMode) {
  AtsIcaModeStage = 0,
  AtsIcaModeDelete = 1,
  AtsIcaModeList = 2,
};

@interface AtsIcaRunner : NSObject <ICDeviceBrowserDelegate, ICCameraDeviceDelegate>
@property(nonatomic, strong) ICDeviceBrowser *browser;
@property(nonatomic, strong) ICCameraDevice *camera;
@property(nonatomic, strong) NSMutableArray<ICCameraDevice *> *seenCameras;
@property(nonatomic, strong) NSString *destDir;
@property(nonatomic, strong) NSString *nameHint;
@property(nonatomic, assign) AtsIcaMode mode;
@property(nonatomic, strong) NSMutableSet<NSString *> *namesToDelete;
@property(nonatomic, strong) NSMutableSet<NSString *> *stemsToDelete;
@property(nonatomic, strong) NSMutableSet<NSString *> *namesToDownload;
@property(nonatomic, strong) NSMutableArray<ICCameraFile *> *files;
@property(nonatomic, strong) NSMutableArray<ICCameraFile *> *filesToDelete;
@property(nonatomic, strong) NSMutableArray<NSString *> *localPaths;
@property(nonatomic, assign) NSUInteger downloadIndex;
@property(nonatomic, assign) NSUInteger deletedCount;
@property(nonatomic, assign) NSUInteger matchedCount;
@property(nonatomic, assign) NSUInteger deleteOffset;
@property(nonatomic, assign) NSUInteger deleteChunkSize;
@property(nonatomic, assign) NSUInteger deletedOkCount;
@property(nonatomic, assign) NSUInteger deleteChunkGen;
@property(nonatomic, assign) AtsIcaPhase phase;
@property(nonatomic, strong) NSString *errorMessage;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) BOOL enumerated;
@property(nonatomic, assign) BOOL openAttempted;
@property(nonatomic, assign) BOOL pendingFinishAfterClose;
@property(nonatomic, assign) BOOL browseRetriesScheduled;
@property(nonatomic, assign) BOOL browseRestartScheduled;
/// After list/stage, keep PTP session open for backup download + clear (GoPro).
@property(nonatomic, assign) BOOL holdSessionAfterStage;
@property(nonatomic, assign) BOOL sessionHeld;
@property(nonatomic, assign) BOOL catalogConsumed;
@property(nonatomic, assign) NSUInteger catalogSettleGen;
@property(nonatomic, assign) ats_ica_progress_cb progressCb;
@property(nonatomic, assign) void *progressCtx;
@property(nonatomic, assign) ats_ica_count_progress_cb deleteProgressCb;
@property(nonatomic, assign) void *deleteProgressCtx;
@property(nonatomic, assign) ats_ica_catalog_tick_cb catalogTickCb;
@property(nonatomic, assign) void *catalogTickCtx;
@property(nonatomic, assign) NSTimeInterval lastCatalogTick;
@property(nonatomic, assign) NSUInteger lastCatalogTickCount;
@property(nonatomic, assign) NSUInteger lastPolledMediaCount;
@property(nonatomic, strong) NSMutableSet<NSString *> *catalogNames;
@property(nonatomic, assign) NSUInteger catalogPollGen;
- (void)stopBrowser;
- (void)parkHeldAfterStage;
- (void)refreshFilesFromCamera;
- (NSArray *)catalogRowDictionaries;
- (BOOL)writeCatalogRows:(NSArray *)rows error:(NSString **)errOut;
- (BOOL)writeCatalogJson:(NSString **)errOut;
- (void)beginList;
- (void)beginDownloads;
- (ICCameraFile *)fileNamed:(NSString *)name;
@end

// Serialize ICA browsers: overlapping stage/delete leaves the PTP session claimed
// and the next plug-in often shows "Gefunden: (keine)" while USB still sees the cam.
static NSLock *AtsIcaOpLock(void) {
  static NSLock *lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [[NSLock alloc] init];
  });
  return lock;
}

static dispatch_queue_t AtsIcaTickQueue(void) {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("de.aero.tandem.ica.catalog-tick", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

// GoPro often cannot re-open PTP after closeSession until the cable is cycled.
// Keep the staging session open so backup clear can delete without re-browsing.
// Never kill PTPCamera — Image Capture Core depends on that helper to list cameras.
static AtsIcaRunner *g_heldRunner = nil;

static void AtsIcaReleaseHeldOnMain(void) {
  NSCAssert([NSThread isMainThread], @"held release on main");
  AtsIcaRunner *held = g_heldRunner;
  g_heldRunner = nil;
  if (!held) {
    return;
  }
  held.sessionHeld = NO;
  held.holdSessionAfterStage = NO;
  ICCameraDevice *cam = held.camera;
  if (cam) {
    cam.delegate = nil;
    if (cam.hasOpenSession) {
      [cam requestCloseSession];
    }
  }
  [held stopBrowser];
  held.camera = nil;
}

static void AtsIcaReleaseHeld(void) {
  __block BOOL hadSession = NO;
  if ([NSThread isMainThread]) {
    hadSession = g_heldRunner != nil;
    AtsIcaReleaseHeldOnMain();
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      hadSession = g_heldRunner != nil;
      AtsIcaReleaseHeldOnMain();
    });
  }
  if (hadSession) {
    // requestCloseSession is async — brief settle before the next browser starts.
    [NSThread sleepForTimeInterval:0.8];
  }
}

void ats_ica_release_held(void) {
  [AtsIcaOpLock() lock];
  AtsIcaReleaseHeld();
  [AtsIcaOpLock() unlock];
}

int ats_ica_has_held(void) {
  [AtsIcaOpLock() lock];
  AtsIcaRunner *runner = g_heldRunner;
  [AtsIcaOpLock() unlock];
  if (!runner) {
    return 0;
  }
  __block int held = 0;
  dispatch_sync(dispatch_get_main_queue(), ^{
    held = (runner.camera != nil && runner.camera.hasOpenSession) ? 1 : 0;
    if (!held) {
      [AtsIcaOpLock() lock];
      if (g_heldRunner == runner) {
        AtsIcaReleaseHeldOnMain();
      }
      [AtsIcaOpLock() unlock];
    }
  });
  return held;
}

@implementation AtsIcaRunner

- (instancetype)initWithDest:(NSString *)dest hint:(NSString *)hint {
  self = [super init];
  if (self) {
    _destDir = [dest copy];
    _nameHint = [hint copy] ?: @"";
    _mode = AtsIcaModeStage;
    _files = [NSMutableArray array];
    _filesToDelete = [NSMutableArray array];
    _namesToDelete = [NSMutableSet set];
    _stemsToDelete = [NSMutableSet set];
    _namesToDownload = [NSMutableSet set];
    _catalogNames = [NSMutableSet set];
    _localPaths = [NSMutableArray array];
    _seenCameras = [NSMutableArray array];
    _phase = AtsIcaPhaseBrowsing;
    _condition = [[NSCondition alloc] init];
  }
  return self;
}

- (instancetype)initForDeleteWithHint:(NSString *)hint names:(NSArray<NSString *> *)names {
  self = [super init];
  if (self) {
    _destDir = @"";
    _nameHint = [hint copy] ?: @"";
    _mode = AtsIcaModeDelete;
    _files = [NSMutableArray array];
    _filesToDelete = [NSMutableArray array];
    _namesToDelete = [NSMutableSet set];
    _stemsToDelete = [NSMutableSet set];
    for (NSString *n in names) {
      NSString *trim = [n stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (trim.length > 0) {
        [_namesToDelete addObject:[trim lowercaseString]];
      }
    }
    _namesToDownload = [NSMutableSet set];
    _catalogNames = [NSMutableSet set];
    _localPaths = [NSMutableArray array];
    _seenCameras = [NSMutableArray array];
    _phase = AtsIcaPhaseBrowsing;
    _condition = [[NSCondition alloc] init];
  }
  return self;
}

- (void)stopBrowser {
  if (self.browser) {
    self.browser.delegate = nil;
    [self.browser stop];
    self.browser = nil;
  }
}

- (BOOL)shouldIgnoreDisconnect {
  return self.finished || self.pendingFinishAfterClose || self.phase == AtsIcaPhaseFailed ||
         self.phase == AtsIcaPhaseDone;
}

- (void)failWithMessage:(NSString *)msg {
  if (self.finished || self.phase == AtsIcaPhaseFailed) {
    return;
  }
  if (g_heldRunner == self) {
    g_heldRunner = nil;
    self.sessionHeld = NO;
  }
  self.errorMessage = msg;
  self.phase = AtsIcaPhaseFailed;
  // Release PTP before waking waiters — otherwise the next import finds no camera.
  if (self.camera && self.camera.hasOpenSession) {
    self.pendingFinishAfterClose = YES;
    [self.camera requestCloseSession];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     if (!self.finished) {
                       [self stopBrowser];
                       [self markFinished];
                     }
                   });
    return;
  }
  [self stopBrowser];
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
      if (name.length == 0 || ![self isMediaName:name]) {
        continue;
      }
      NSString *key = name.lastPathComponent.lowercaseString;
      if ([self.catalogNames containsObject:key]) {
        continue;
      }
      [self.catalogNames addObject:key];
      [self.files addObject:file];
    } else if ([item isKindOfClass:[ICCameraFolder class]]) {
      ICCameraFolder *folder = (ICCameraFolder *)item;
      if (folder.contents.count > 0) {
        [self collectFilesFromItems:folder.contents];
      }
    }
  }
}

- (void)refreshFilesFromCamera {
  [self.files removeAllObjects];
  [self.catalogNames removeAllObjects];
  if (!self.camera) {
    self.lastPolledMediaCount = 0;
    return;
  }
  self.lastPolledMediaCount = self.camera.mediaFiles.count;
  if (self.camera.mediaFiles.count > 0) {
    for (ICCameraItem *item in self.camera.mediaFiles) {
      if ([item isKindOfClass:[ICCameraFile class]]) {
        ICCameraFile *file = (ICCameraFile *)item;
        NSString *name = file.name ?: @"";
        if (name.length == 0 || ![self isMediaName:name]) {
          continue;
        }
        NSString *key = name.lastPathComponent.lowercaseString;
        if ([self.catalogNames containsObject:key]) {
          continue;
        }
        [self.catalogNames addObject:key];
        [self.files addObject:file];
      }
    }
  }
  if (self.files.count == 0 && self.camera.contents.count > 0) {
    [self collectFilesFromItems:self.camera.contents];
  }
}

- (ICCameraFile *)fileNamed:(NSString *)name {
  NSString *want = name.lastPathComponent.lowercaseString;
  if (want.length == 0) {
    return nil;
  }
  for (ICCameraFile *file in self.files) {
    NSString *n = file.name.lastPathComponent.lowercaseString;
    if ([n isEqualToString:want]) {
      return file;
    }
  }
  // Don't rebuild the live catalog for a thumb miss — that stalls PTP listing.
  if (self.mode == AtsIcaModeList && !self.catalogConsumed) {
    return nil;
  }
  [self refreshFilesFromCamera];
  for (ICCameraFile *file in self.files) {
    NSString *n = file.name.lastPathComponent.lowercaseString;
    if ([n isEqualToString:want]) {
      return file;
    }
  }
  return nil;
}

- (NSArray *)catalogRowDictionaries {
  NSMutableArray *rows = [NSMutableArray arrayWithCapacity:self.files.count];
  for (ICCameraFile *file in self.files) {
    NSString *name = file.name ?: file.originalFilename ?: @"";
    if (name.length == 0) {
      continue;
    }
    NSDate *d = file.modificationDate ?: file.creationDate;
    NSTimeInterval ts = d ? [d timeIntervalSince1970] : 0;
    long long sz = (long long)file.fileSize;
    if (sz < 0) {
      sz = 0;
    }
    [rows addObject:@{
      @"name" : name,
      @"size" : @(sz),
      @"mtime" : @(ts),
    }];
  }
  return rows;
}

- (BOOL)writeCatalogRows:(NSArray *)rows error:(NSString **)errOut {
  if (self.destDir.length == 0) {
    if (errOut) {
      *errOut = @"Kein Zielordner für den Katalog.";
    }
    return NO;
  }
  NSError *err = nil;
  [[NSFileManager defaultManager] createDirectoryAtPath:self.destDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:&err];
  if (err) {
    if (errOut) {
      *errOut = err.localizedDescription;
    }
    return NO;
  }
  NSArray *sorted = [rows sortedArrayUsingComparator:^NSComparisonResult(id a, id b) {
    NSDictionary *da = (NSDictionary *)a;
    NSDictionary *db = (NSDictionary *)b;
    NSTimeInterval ta = [da[@"mtime"] doubleValue];
    NSTimeInterval tb = [db[@"mtime"] doubleValue];
    if (ta != tb) {
      return ta < tb ? NSOrderedAscending : NSOrderedDescending;
    }
    NSString *na = da[@"name"] ?: @"";
    NSString *nb = db[@"name"] ?: @"";
    return [na compare:nb options:NSNumericSearch | NSCaseInsensitiveSearch];
  }];
  NSData *data = [NSJSONSerialization dataWithJSONObject:sorted options:0 error:&err];
  if (!data || err) {
    if (errOut) {
      *errOut = err.localizedDescription ?: @"Katalog schreiben fehlgeschlagen.";
    }
    return NO;
  }
  NSString *path = [self.destDir stringByAppendingPathComponent:@".ats_ica_catalog.json"];
  if (![data writeToFile:path options:NSDataWritingAtomic error:&err]) {
    if (errOut) {
      *errOut = err.localizedDescription ?: @"Katalog schreiben fehlgeschlagen.";
    }
    return NO;
  }
  return YES;
}

- (BOOL)writeCatalogJson:(NSString **)errOut {
  return [self writeCatalogRows:[self catalogRowDictionaries] error:errOut];
}

- (void)onCatalogReady {
  if (self.catalogConsumed || self.finished) {
    return;
  }
  self.catalogConsumed = YES;
  self.phase = AtsIcaPhaseReady;
  if (self.mode == AtsIcaModeDelete) {
    [self beginDelete];
  } else if (self.mode == AtsIcaModeList) {
    [self beginList];
  } else {
    [self beginDownloads];
  }
}

- (void)maybeTickCatalog:(BOOL)force {
  if (self.mode != AtsIcaModeList || !self.catalogTickCb) {
    return;
  }
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  BOOL firstBatch = self.lastCatalogTickCount == 0 && self.files.count > 0;
  NSTimeInterval minGap = self.lastCatalogTickCount < 48 ? 0.28 : 0.7;
  NSUInteger minAdded = self.lastCatalogTickCount < 48 ? 8 : 64;
  if (!force && !firstBatch && (now - self.lastCatalogTick) < minGap &&
      self.files.count < self.lastCatalogTickCount + minAdded) {
    return;
  }
  if (self.files.count == 0) {
    return;
  }
  NSArray *rows = [self catalogRowDictionaries];
  if (rows.count == 0) {
    return;
  }
  self.lastCatalogTick = now;
  self.lastCatalogTickCount = self.files.count;
  ats_ica_catalog_tick_cb cb = self.catalogTickCb;
  void *ctx = self.catalogTickCtx;
  if (!cb) {
    [self writeCatalogRows:rows error:nil];
    return;
  }
  // Snapshot on the ICA thread; JSON + frontend tick stay off the UI run loop.
  dispatch_async(AtsIcaTickQueue(), ^{
    if (![self writeCatalogRows:rows error:nil]) {
      return;
    }
    cb(ctx);
  });
}

- (void)scheduleCatalogPoll {
  if (self.mode != AtsIcaModeList || self.catalogConsumed || self.finished) {
    return;
  }
  NSUInteger gen = ++self.catalogPollGen;
  NSTimeInterval delay = self.files.count < 40 ? 0.22 : 0.55;
  __weak AtsIcaRunner *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   AtsIcaRunner *strong = weakSelf;
                   if (!strong || strong.catalogPollGen != gen || strong.catalogConsumed ||
                       strong.finished) {
                     return;
                   }
                   NSUInteger before = strong.files.count;
                   NSUInteger cameraN = strong.camera ? strong.camera.mediaFiles.count : 0;
                   if (cameraN > strong.lastPolledMediaCount) {
                     [strong refreshFilesFromCamera];
                   }
                   if (strong.files.count > before || (before == 0 && strong.files.count > 0)) {
                     [strong maybeTickCatalog:before == 0];
                   }
                   if (!strong.catalogConsumed && !strong.finished) {
                     [strong scheduleCatalogPoll];
                   }
                 });
}

- (void)scheduleCatalogSettle {
  if (self.catalogConsumed || self.finished) {
    return;
  }
  if (self.phase != AtsIcaPhaseOpening && self.phase != AtsIcaPhaseReady) {
    return;
  }
  NSUInteger gen = ++self.catalogSettleGen;
  __weak AtsIcaRunner *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   AtsIcaRunner *strong = weakSelf;
                   if (!strong || strong.catalogSettleGen != gen || strong.catalogConsumed ||
                       strong.finished) {
                     return;
                   }
                   BOOL hasItems = strong.camera && (strong.camera.mediaFiles.count > 0 ||
                                                     strong.camera.contents.count > 0);
                   if (!hasItems) {
                     return;
                   }
                   [strong onCatalogReady];
                 });
}

- (void)startBrowsingOnMain {
  NSAssert([NSThread isMainThread], @"ICDeviceBrowser must start on main thread");
  self.browser = [[ICDeviceBrowser alloc] init];
  self.browser.delegate = self;
  // Local USB/FireWire only. Shared/Bonjour pulls in network printers (HP etc.)
  // whose flaky XPC links interrupt PTP and leave GoPro stuck in "starting"
  // so didAddDevice never fires → "Gefunden: (keine)".
  self.browser.browsedDeviceTypeMask =
      (ICDeviceTypeMask)(ICDeviceTypeMaskCamera | ICDeviceLocationTypeMaskLocal);
  [self.browser start];
}

- (void)rememberCamera:(ICDevice *)device {
  if ((device.type & ICDeviceTypeCamera) == 0) {
    return;
  }
  if (![device isKindOfClass:[ICCameraDevice class]]) {
    return;
  }
  // Skip network/Bonjour scanners that still report as cameras (HP AirPrint etc.).
  NSString *transport = device.transportType;
  if (transport.length > 0 &&
      ![transport isEqualToString:(NSString *)ICTransportTypeUSB] &&
      ![transport isEqualToString:(NSString *)ICTransportTypeFireWire]) {
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

- (void)scheduleBrowseRetries {
  if (self.browseRetriesScheduled) {
    return;
  }
  self.browseRetriesScheduled = YES;
  __weak AtsIcaRunner *weakSelf = self;
  // GoPro often re-enumerates PTP several seconds after USB hotplug / session close.
  for (NSInteger i = 1; i <= 20; i++) {
    NSTimeInterval delay = 1.0 * (double)i;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     AtsIcaRunner *strong = weakSelf;
                     if (!strong || strong.finished || strong.openAttempted) {
                       return;
                     }
                     [strong tryOpenBestCamera];
                   });
  }
  // One clean browser restart if ICA authorized the cam but never delivered didAddDevice.
  if (!self.browseRestartScheduled) {
    self.browseRestartScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(7.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     AtsIcaRunner *strong = weakSelf;
                     if (!strong || strong.finished || strong.openAttempted) {
                       return;
                     }
                     if (strong.seenCameras.count > 0) {
                       return;
                     }
                     [strong stopBrowser];
                     dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.45 * NSEC_PER_SEC)),
                                    dispatch_get_main_queue(), ^{
                                      AtsIcaRunner *inner = weakSelf;
                                      if (!inner || inner.finished || inner.openAttempted) {
                                        return;
                                      }
                                      if (inner.seenCameras.count > 0) {
                                        return;
                                      }
                                      [inner startBrowsingOnMain];
                                    });
                   });
  }
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
    [self scheduleBrowseRetries];
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
  // Prevent Photos / Image Capture.app from stealing the PTP session on connect.
  self.camera.autolaunchApplicationPath = nil;
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
      @"Keine passende USB-Kamera in Bildübernahme gefunden. Gefunden: %@. Hinweis: %@. "
       "Bitte „Fotos“ und „Bildübernahme“ schließen, an der GoPro den USB-Bildschirm "
       "bestätigen, Kabel kurz ab/an — oder MicroSD im Kartenleser nutzen. "
       "Systemeinstellungen → Datenschutz → Wechseldatenträger: Aero Tandem Studio erlauben.",
      joined, self.nameHint]];
}

- (void)collectAllFilesFromItems:(NSArray<ICCameraItem *> *)items
                            into:(NSMutableArray<ICCameraFile *> *)out {
  for (ICCameraItem *item in items) {
    if ([item isKindOfClass:[ICCameraFile class]]) {
      [out addObject:(ICCameraFile *)item];
    } else if ([item isKindOfClass:[ICCameraFolder class]]) {
      ICCameraFolder *folder = (ICCameraFolder *)item;
      if (folder.contents.count > 0) {
        [self collectAllFilesFromItems:folder.contents into:out];
      }
    }
  }
}

- (void)parkHeldAfterStage {
  self.phase = AtsIcaPhaseDone;
  self.sessionHeld = YES;
  // Replace any previous held session (same or stale camera).
  if (g_heldRunner && g_heldRunner != self) {
    AtsIcaRunner *prev = g_heldRunner;
    g_heldRunner = nil;
    prev.sessionHeld = NO;
    prev.holdSessionAfterStage = NO;
    if (prev.camera) {
      prev.camera.delegate = nil;
      if (prev.camera.hasOpenSession) {
        [prev.camera requestCloseSession];
      }
    }
    [prev stopBrowser];
  }
  g_heldRunner = self;
  // Keep ICDeviceBrowser running while the PTP session is held. Stopping it
  // drops the camera from Image Capture; GoPro then cannot re-open until the
  // cable is cycled ("Gefunden: (keine)" on backup).
  __weak AtsIcaRunner *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * 60 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   AtsIcaRunner *strong = weakSelf;
                   if (!strong || g_heldRunner != strong) {
                     return;
                   }
                   [AtsIcaOpLock() lock];
                   if (g_heldRunner == strong) {
                     AtsIcaReleaseHeldOnMain();
                   }
                   [AtsIcaOpLock() unlock];
                 });
  [self markFinished];
}

- (void)finishSessionSuccess {
  self.phase = AtsIcaPhaseDone;
  if (self.sessionHeld && g_heldRunner == self) {
    g_heldRunner = nil;
    self.sessionHeld = NO;
  }
  if (self.camera && self.camera.hasOpenSession) {
    self.pendingFinishAfterClose = YES;
    [self.camera requestCloseSession];
    // Fallback if didCloseSession never arrives (some GoPro firmwares).
    __weak AtsIcaRunner *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     AtsIcaRunner *strong = weakSelf;
                     if (!strong || strong.finished) {
                       return;
                     }
                     [strong stopBrowser];
                     [strong markFinished];
                   });
    return;
  }
  [self stopBrowser];
  [self markFinished];
}

- (NSArray<NSString *> *)nameKeysForFile:(ICCameraFile *)file {
  NSMutableArray *keys = [NSMutableArray array];
  NSArray *raw = @[
    file.name ?: @"",
    file.originalFilename ?: @"",
    file.createdFilename ?: @"",
  ];
  for (NSString *r in raw) {
    if (r.length == 0) {
      continue;
    }
    NSString *base = r.lastPathComponent.lowercaseString;
    if (base.length > 0) {
      [keys addObject:base];
    }
  }
  return keys;
}

- (BOOL)fileMatchesDeleteNames:(ICCameraFile *)file {
  for (NSString *key in [self nameKeysForFile:file]) {
    if ([self.namesToDelete containsObject:key]) {
      return YES;
    }
    NSString *stem = [key stringByDeletingPathExtension];
    if (stem.length > 0 && [self.stemsToDelete containsObject:stem]) {
      return YES;
    }
  }
  return NO;
}

- (void)rebuildDeleteStems {
  if (!self.stemsToDelete) {
    self.stemsToDelete = [NSMutableSet set];
  }
  [self.stemsToDelete removeAllObjects];
  for (NSString *n in self.namesToDelete) {
    NSString *base = n.lastPathComponent.lowercaseString;
    if (base.length == 0) {
      continue;
    }
    NSString *stem = [base stringByDeletingPathExtension];
    if (stem.length == 0) {
      continue;
    }
    [self.stemsToDelete addObject:stem];
    if (stem.length >= 2) {
      unichar c0 = [stem characterAtIndex:0];
      unichar c1 = [stem characterAtIndex:1];
      if (c0 == 'g' && (c1 == 'x' || c1 == 'h')) {
        [self.stemsToDelete addObject:[@"gl" stringByAppendingString:[stem substringFromIndex:2]]];
      }
    }
  }
}

- (void)emitDeleteProgress {
  if (!self.deleteProgressCb) {
    return;
  }
  unsigned int total = (unsigned int)self.filesToDelete.count;
  unsigned int current = (unsigned int)self.deletedOkCount;
  self.deleteProgressCb(current, total, self.deleteProgressCtx);
}

- (void)deleteNextChunk {
  if (self.finished || self.phase == AtsIcaPhaseFailed) {
    return;
  }
  if (self.deleteOffset >= self.filesToDelete.count) {
    self.deletedCount = self.deletedOkCount;
    if (self.deletedCount == 0) {
      [self failWithMessage:@"Kamera-Bereinigung: keine Dateien gelöscht."];
      return;
    }
    [self finishSessionSuccess];
    return;
  }

  NSUInteger remaining = self.filesToDelete.count - self.deleteOffset;
  NSUInteger n = MIN(self.deleteChunkSize, remaining);
  NSArray<ICCameraFile *> *chunk =
      [self.filesToDelete subarrayWithRange:NSMakeRange(self.deleteOffset, n)];
  self.deleteOffset += n;
  self.deleteChunkGen += 1;
  NSUInteger gen = self.deleteChunkGen;

  if (@available(macOS 10.15, *)) {
    __weak AtsIcaRunner *weakSelf = self;
    [self.camera
        requestDeleteFiles:chunk
              deleteFailed:^(NSDictionary<ICDeleteError, ICCameraItem *> *_Nonnull failed) {
                (void)failed;
              }
                completion:^(
                    NSDictionary<ICDeleteResult, NSArray<ICCameraItem *> *> *_Nonnull result,
                    NSError *_Nullable error) {
                  dispatch_async(dispatch_get_main_queue(), ^{
                    AtsIcaRunner *strong = weakSelf;
                    if (!strong || strong.finished || strong.deleteChunkGen != gen) {
                      return;
                    }
                    NSArray *ok = result[ICDeleteSuccessful] ?: @[];
                    strong.deletedOkCount += ok.count;
                    [strong emitDeleteProgress];
                    if (error && ok.count == 0) {
                      [strong failWithMessage:[NSString stringWithFormat:
                          @"Löschen auf der Kamera fehlgeschlagen: %@",
                          error.localizedDescription]];
                      return;
                    }
                    [strong deleteNextChunk];
                  });
                }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(20.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     AtsIcaRunner *strong = weakSelf;
                     if (!strong || strong.finished || strong.deleteChunkGen != gen) {
                       return;
                     }
                     strong.deleteChunkGen += 1;
                     [strong failWithMessage:
                         @"Timeout beim Löschen auf der USB-Kamera (Bildübernahme)."];
                   });
  } else {
    [self.camera requestDeleteFiles:chunk];
  }
}

- (void)beginDelete {
  NSArray *caps = self.camera.capabilities ?: @[];
  BOOL canDeleteOne = [caps containsObject:ICCameraDeviceCanDeleteOneFile];
  BOOL canDeleteAll = [caps containsObject:ICCameraDeviceCanDeleteAllFiles];
  BOOL canDelete = canDeleteOne || canDeleteAll;

  if (self.namesToDelete.count == 0) {
    [self failWithMessage:@"Keine Dateinamen für die Kamera-Bereinigung übergeben."];
    return;
  }
  [self rebuildDeleteStems];

  NSMutableArray<ICCameraFile *> *all = [NSMutableArray array];
  if (self.camera.mediaFiles.count > 0) {
    for (ICCameraItem *item in self.camera.mediaFiles) {
      if ([item isKindOfClass:[ICCameraFile class]]) {
        [all addObject:(ICCameraFile *)item];
      }
    }
  }
  if (self.camera.contents.count > 0) {
    [self collectAllFilesFromItems:self.camera.contents into:all];
  }

  [self.filesToDelete removeAllObjects];
  NSMutableSet *matchedKeys = [NSMutableSet set];
  NSUInteger lockedMatches = 0;
  for (ICCameraFile *file in all) {
    if (![self fileMatchesDeleteNames:file]) {
      continue;
    }
    if (file.locked) {
      lockedMatches += 1;
      continue;
    }
    NSString *primary = (file.name ?: file.originalFilename ?: @"").lowercaseString;
    if (primary.length == 0 || [matchedKeys containsObject:primary]) {
      continue;
    }
    [self.filesToDelete addObject:file];
    [matchedKeys addObject:primary];
  }
  self.matchedCount = self.filesToDelete.count;

  if (self.filesToDelete.count == 0 && lockedMatches > 0) {
    [self failWithMessage:[NSString stringWithFormat:
        @"%lu passende Datei(en) sind auf der Kamera gesperrt (Schreibschutz) und können nicht gelöscht werden.",
        (unsigned long)lockedMatches]];
    return;
  }

  if (self.filesToDelete.count == 0) {
    NSMutableArray *sample = [NSMutableArray array];
    for (ICCameraFile *file in all) {
      if (sample.count >= 8) {
        break;
      }
      NSString *n = file.name ?: file.originalFilename ?: @"(ohne Namen)";
      [sample addObject:n];
    }
    NSString *seen = sample.count ? [sample componentsJoinedByString:@", "] : @"(Katalog leer)";
    NSArray *wanted = [self.namesToDelete allObjects];
    NSString *wantSample = [[wanted sortedArrayUsingSelector:@selector(compare:)]
        componentsJoinedByString:@", "];
    if (wantSample.length > 180) {
      wantSample = [[wantSample substringToIndex:180] stringByAppendingString:@"…"];
    }
    [self failWithMessage:[NSString stringWithFormat:
        @"Keine der gesicherten Dateien auf der Kamera zum Löschen gefunden "
         "(%lu Kameradatei(en) sichtbar: %@). Gesucht u.a.: %@",
        (unsigned long)all.count, seen, wantSample]];
    return;
  }

  if (!canDelete) {
    [self failWithMessage:
        @"Diese Kamera meldet kein USB-Löschen (Bildübernahme). "
         "Bitte MicroSD im Kartenleser nutzen oder Dateien an der Kamera löschen."];
    return;
  }

  self.deleteChunkSize = canDeleteAll ? 8 : 1;
  self.deleteOffset = 0;
  self.deletedOkCount = 0;
  self.deletedCount = 0;
  self.phase = AtsIcaPhaseDeleting;
  [self emitDeleteProgress];
  [self deleteNextChunk];
}

- (void)beginList {
  [self refreshFilesFromCamera];
  if (self.files.count == 0) {
    [self failWithMessage:@"Keine Medien auf der Kamera gefunden."];
    return;
  }
  NSString *err = nil;
  if (![self writeCatalogJson:&err]) {
    [self failWithMessage:err ?: @"Katalog schreiben fehlgeschlagen."];
    return;
  }
  [self maybeTickCatalog:YES];
  if (self.holdSessionAfterStage) {
    [self parkHeldAfterStage];
  } else {
    [self finishSessionSuccess];
  }
}

- (BOOL)fileMatchesDownloadNames:(ICCameraFile *)file {
  if (self.namesToDownload.count == 0) {
    return YES;
  }
  for (NSString *key in [self nameKeysForFile:file]) {
    if ([self.namesToDownload containsObject:key]) {
      return YES;
    }
  }
  return NO;
}

- (unsigned long long)catalogBytesTotal {
  unsigned long long total = 0;
  for (ICCameraFile *file in self.files) {
    long long sz = (long long)file.fileSize;
    if (sz > 0) {
      total += (unsigned long long)sz;
    }
  }
  return total;
}

- (unsigned long long)downloadedBytesSoFar {
  unsigned long long total = 0;
  NSFileManager *fm = [NSFileManager defaultManager];
  for (NSString *path in self.localPaths) {
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    NSNumber *sz = attrs[NSFileSize];
    if (sz) {
      total += sz.unsignedLongLongValue;
    }
  }
  return total;
}

- (void)emitDownloadProgressNamed:(NSString *)name {
  if (!self.progressCb) {
    return;
  }
  unsigned int idx = (unsigned int)MIN(self.downloadIndex + 1, self.files.count);
  unsigned int tot = (unsigned int)self.files.count;
  const char *utf8 = name.UTF8String ?: "";
  self.progressCb(idx, tot, utf8, [self downloadedBytesSoFar], [self catalogBytesTotal],
                  self.progressCtx);
}

- (void)beginDownloads {
  [self refreshFilesFromCamera];
  if (self.namesToDownload.count > 0) {
    NSMutableArray<ICCameraFile *> *filtered = [NSMutableArray array];
    NSMutableSet *matched = [NSMutableSet set];
    for (ICCameraFile *file in self.files) {
      if (![self fileMatchesDownloadNames:file]) {
        continue;
      }
      NSString *primary = (file.name ?: file.originalFilename ?: @"").lowercaseString;
      if (primary.length == 0 || [matched containsObject:primary]) {
        continue;
      }
      [filtered addObject:file];
      [matched addObject:primary];
    }
    self.files = filtered;
  }
  if (self.files.count == 0) {
    [self failWithMessage:self.namesToDownload.count > 0
                              ? @"Keine der ausgewählten Dateien auf der Kamera gefunden."
                              : @"Keine Medien auf der Kamera gefunden."];
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
  [self.localPaths removeAllObjects];
  [self emitDownloadProgressNamed:(self.files.firstObject.name ?: @"")];
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
    if (self.holdSessionAfterStage) {
      [self parkHeldAfterStage];
    } else {
      [self finishSessionSuccess];
    }
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
                       outPath = destPath;
                     }
                     strong.downloadIndex += 1;
                     NSString *progressName = outPath.lastPathComponent ?: name;
                     [strong emitDownloadProgressNamed:progressName];
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
  // Open as soon as we see a match — do not wait for moreComing=NO (can stall on GoPro).
  [self tryOpenBestCamera];
  if (moreComing) {
    [self scheduleBrowseRetries];
  }
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser
      didRemoveDevice:(ICDevice *)device
            moreGoing:(BOOL)moreGoing {
  (void)browser;
  (void)moreGoing;
  if (self.sessionHeld && g_heldRunner == self &&
      self.camera && device == (ICDevice *)self.camera) {
    g_heldRunner = nil;
    self.sessionHeld = NO;
    [self stopBrowser];
    return;
  }
  if ([self shouldIgnoreDisconnect]) {
    if ([device isKindOfClass:[ICCameraDevice class]]) {
      [self.seenCameras removeObject:(ICCameraDevice *)device];
    }
    return;
  }
  if (self.camera && device == (ICDevice *)self.camera) {
    [self failWithMessage:@"Kamera wurde getrennt."];
  }
  if ([device isKindOfClass:[ICCameraDevice class]]) {
    [self.seenCameras removeObject:(ICCameraDevice *)device];
  }
}

- (void)deviceBrowserDidEnumerateLocalDevices:(ICDeviceBrowser *)browser {
  (void)browser;
  self.enumerated = YES;
  // Do NOT fail if empty — USB/PTP devices often appear after this callback.
  [self tryOpenBestCamera];
  if (self.phase == AtsIcaPhaseBrowsing && self.seenCameras.count == 0) {
    [self scheduleBrowseRetries];
  }
}

#pragma mark - ICDeviceDelegate / ICCameraDeviceDelegate

- (void)didRemoveDevice:(ICDevice *)device {
  (void)device;
  if (self.sessionHeld && g_heldRunner == self) {
    g_heldRunner = nil;
    self.sessionHeld = NO;
    [self stopBrowser];
    return;
  }
  if ([self shouldIgnoreDisconnect]) {
    return;
  }
  [self failWithMessage:@"Kamera wurde getrennt."];
}

- (void)device:(ICDevice *)device didOpenSessionWithError:(NSError *)error {
  (void)device;
  if (error) {
    [self failWithMessage:error.localizedDescription];
    return;
  }
  // Publish the live PTP session immediately so catalog ticks + thumbnails
  // can run while the full GoPro listing still settles (~1 min for 700+ files).
  if (self.mode == AtsIcaModeList) {
    self.sessionHeld = YES;
    if (g_heldRunner && g_heldRunner != self) {
      AtsIcaRunner *prev = g_heldRunner;
      g_heldRunner = nil;
      prev.sessionHeld = NO;
      prev.holdSessionAfterStage = NO;
      if (prev.camera && prev.camera.hasOpenSession) {
        prev.camera.delegate = nil;
        [prev.camera requestCloseSession];
      }
      [prev stopBrowser];
    }
    g_heldRunner = self;
    [self scheduleCatalogPoll];
  }
}

- (void)device:(ICDevice *)device didCloseSessionWithError:(NSError *)error {
  (void)device;
  (void)error;
  if (self.pendingFinishAfterClose || self.phase == AtsIcaPhaseDone ||
      self.phase == AtsIcaPhaseFailed) {
    self.pendingFinishAfterClose = NO;
    [self stopBrowser];
    [self markFinished];
  }
}

- (void)deviceDidBecomeReadyWithCompleteContentCatalog:(ICCameraDevice *)device {
  (void)device;
  [self onCatalogReady];
}

- (void)cameraDevice:(ICCameraDevice *)camera didAddItems:(NSArray<ICCameraItem *> *)items {
  (void)camera;
  if (self.mode == AtsIcaModeList && items.count > 0) {
    NSUInteger before = self.files.count;
    [self collectFilesFromItems:items];
    if (self.camera) {
      NSUInteger n = self.camera.mediaFiles.count;
      if (n > self.lastPolledMediaCount) {
        self.lastPolledMediaCount = n;
      }
    }
    [self maybeTickCatalog:before == 0];
  }
  [self scheduleCatalogSettle];
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
  if (self.mode == AtsIcaModeList && self.camera.mediaFiles.count > 0) {
    [self refreshFilesFromCamera];
    [self maybeTickCatalog:self.lastCatalogTickCount == 0];
  }
  [self scheduleCatalogSettle];
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
  if (self.mode != AtsIcaModeDelete || self.finished) {
    return;
  }
  // Prefer the macOS 10.15+ completion handler; this is the legacy fallback.
  if (@available(macOS 10.15, *)) {
    return;
  }
  if (error) {
    [self failWithMessage:[NSString stringWithFormat:
        @"Löschen auf der Kamera fehlgeschlagen: %@", error.localizedDescription]];
    return;
  }
  if (self.matchedCount == 0 || self.filesToDelete.count == 0) {
    [self failWithMessage:@"Kamera-Bereinigung: keine Dateien gelöscht."];
    return;
  }
  self.deletedCount = self.filesToDelete.count;
  [self finishSessionSuccess];
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

static BOOL ats_ica_wait_runner(AtsIcaRunner *runner, NSTimeInterval overallSec,
                                NSTimeInterval browseSec) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:overallSec];
  NSDate *browseDeadline = [NSDate dateWithTimeIntervalSinceNow:browseSec];
  BOOL browseTimedOut = NO;

  [runner.condition lock];
  while (!runner.finished && [deadline timeIntervalSinceNow] > 0) {
    [runner.condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
    if (!browseTimedOut && !runner.finished && runner.phase == AtsIcaPhaseBrowsing &&
        [browseDeadline timeIntervalSinceNow] <= 0) {
      browseTimedOut = YES;
      [runner.condition unlock];
      dispatch_sync(dispatch_get_main_queue(), ^{
        [runner failIfStillBrowsing];
      });
      [runner.condition lock];
      // fail may still be closing a session — keep waiting for finished.
      continue;
    }
  }
  if (!runner.finished) {
    [runner.condition unlock];
    dispatch_sync(dispatch_get_main_queue(), ^{
      NSString *msg = runner.mode == AtsIcaModeDelete
                          ? @"Timeout beim Löschen auf der USB-Kamera (Bildübernahme)."
                      : runner.mode == AtsIcaModeList
                            ? @"Timeout beim Lesen der Dateiliste (Bildübernahme)."
                            : @"Timeout beim USB-Kamera-Import (Bildübernahme).";
      [runner failWithMessage:msg];
    });
    [runner.condition lock];
    // Allow pending session-close path to finish.
    NSDate *closeDeadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
    while (!runner.finished && [closeDeadline timeIntervalSinceNow] > 0) {
      [runner.condition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    }
  }
  [runner.condition unlock];

  BOOL keepHeld = runner.sessionHeld && runner.phase == AtsIcaPhaseDone && g_heldRunner == runner;
  if (!keepHeld) {
    dispatch_sync(dispatch_get_main_queue(), ^{
      [runner stopBrowser];
    });
    [NSThread sleepForTimeInterval:0.35];
  }

  return runner.phase == AtsIcaPhaseDone;
}

static BOOL ats_ica_held_usable(void) {
  if (!g_heldRunner) {
    return NO;
  }
  __block BOOL heldUsable = NO;
  dispatch_sync(dispatch_get_main_queue(), ^{
    heldUsable = g_heldRunner.camera != nil && g_heldRunner.camera.hasOpenSession;
    if (!heldUsable) {
      AtsIcaReleaseHeldOnMain();
    }
  });
  return heldUsable;
}

static NSData *AtsIcaJpegFromCGImage(CGImageRef image) {
  if (!image) {
    return nil;
  }
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL);
  if (!dest) {
    return nil;
  }
  NSDictionary *props = @{
    (id)kCGImageDestinationLossyCompressionQuality : @0.55,
  };
  CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)props);
  BOOL ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  return ok ? data : nil;
}

/**
 * Copy a JPEG thumbnail for `name` from the held PTP session into dest_jpeg.
 * Returns 0 on success, 3 if the ICA lock is busy (backup in progress).
 */
int ats_ica_thumbnail_named(const char *name_utf8, const char *dest_jpeg_utf8,
                            unsigned int max_edge, char *err_buf, size_t err_len) {
  if (!name_utf8 || !name_utf8[0] || !dest_jpeg_utf8 || !dest_jpeg_utf8[0]) {
    ats_set_error(err_buf, err_len, @"Kein Thumbnail-Pfad angegeben.");
    return 1;
  }
  if (![AtsIcaOpLock() tryLock]) {
    ats_set_error(err_buf, err_len, @"busy");
    return 3;
  }
  AtsIcaRunner *runner = g_heldRunner;
  BOOL live = runner != nil && runner.camera != nil && runner.camera.hasOpenSession;
  [AtsIcaOpLock() unlock];
  if (!live) {
    ats_set_error(err_buf, err_len, @"Keine offene Kamera-Session.");
    return 2;
  }

  @autoreleasepool {
    NSString *want = [NSString stringWithUTF8String:name_utf8];
    NSString *destPath = [NSString stringWithUTF8String:dest_jpeg_utf8];
    (void)max_edge;

    NSCondition *cond = [[NSCondition alloc] init];
    __block BOOL done = NO;
    __block NSData *jpeg = nil;
    __block NSString *fail = nil;

    dispatch_async(dispatch_get_main_queue(), ^{
      if (!runner.camera || !runner.camera.hasOpenSession) {
        fail = @"Keine offene Kamera-Session.";
        [cond lock];
        done = YES;
        [cond broadcast];
        [cond unlock];
        return;
      }
      ICCameraFile *file = [runner fileNamed:want];
      if (!file) {
        fail = @"Datei nicht in der Kamera-Session.";
        [cond lock];
        done = YES;
        [cond broadcast];
        [cond unlock];
        return;
      }
      if (file.thumbnail) {
        jpeg = AtsIcaJpegFromCGImage(file.thumbnail);
        if (jpeg.length > 32) {
          [cond lock];
          done = YES;
          [cond broadcast];
          [cond unlock];
          return;
        }
      }
      if (@available(macOS 10.15, *)) {
        [file requestThumbnailDataWithOptions:@{}
                                   completion:^(NSData *_Nullable data, NSError *_Nullable error) {
                                     if (error) {
                                       fail = error.localizedDescription;
                                     } else {
                                       jpeg = data;
                                     }
                                     [cond lock];
                                     done = YES;
                                     [cond broadcast];
                                     [cond unlock];
                                   }];
      } else {
        fail = @"Thumbnails erfordern macOS 10.15+.";
        [cond lock];
        done = YES;
        [cond broadcast];
        [cond unlock];
      }
    });

    [cond lock];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8.0];
    while (!done && [deadline timeIntervalSinceNow] > 0) {
      [cond waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    }
    [cond unlock];

    if (!done) {
      ats_set_error(err_buf, err_len, @"Timeout beim Kamera-Thumbnail.");
      return 2;
    }
    if (jpeg.length < 32) {
      ats_set_error(err_buf, err_len, fail ?: @"Kein Thumbnail von der Kamera.");
      return 2;
    }

    NSError *writeErr = nil;
    NSString *dir = destPath.stringByDeletingLastPathComponent;
    [[NSFileManager defaultManager] createDirectoryAtPath:dir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    if (![jpeg writeToFile:destPath options:NSDataWritingAtomic error:&writeErr]) {
      ats_set_error(err_buf, err_len, writeErr.localizedDescription ?: @"Thumbnail schreiben fehlgeschlagen.");
      return 2;
    }
    return 0;
  }
}

static void ats_ica_fill_name_set(NSMutableSet *set, NSString *raw) {
  NSArray *parts = [raw componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]];
  for (NSString *p in parts) {
    NSString *trim =
        [p stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trim.length > 0) {
      [set addObject:[trim lowercaseString]];
    }
  }
}

/**
 * Enumerate camera media into dest_dir/.ats_ica_catalog.json without downloading.
 * Keeps the PTP session held for a following download/clear.
 */
int ats_ica_list_catalog(const char *dest_dir_utf8, const char *name_hint_utf8,
                         ats_ica_catalog_tick_cb tick, void *tick_ctx, char *err_buf,
                         size_t err_len) {
  if (!dest_dir_utf8 || !dest_dir_utf8[0]) {
    ats_set_error(err_buf, err_len, @"Kein Zielordner angegeben.");
    return 1;
  }

  [AtsIcaOpLock() lock];
  @autoreleasepool {
    NSString *dest = [NSString stringWithUTF8String:dest_dir_utf8];
    NSString *hint =
        name_hint_utf8 ? [NSString stringWithUTF8String:name_hint_utf8] : @"";

    if (ats_ica_held_usable() && g_heldRunner) {
      AtsIcaRunner *runner = g_heldRunner;
      __block NSString *writeErr = nil;
      __block BOOL wrote = NO;
      dispatch_sync(dispatch_get_main_queue(), ^{
        runner.destDir = dest;
        [runner refreshFilesFromCamera];
        wrote = [runner writeCatalogJson:&writeErr];
      });
      [AtsIcaOpLock() unlock];
      if (!wrote) {
        ats_set_error(err_buf, err_len, writeErr ?: @"Katalog schreiben fehlgeschlagen.");
        return 2;
      }
      if (tick) {
        tick(tick_ctx);
      }
      return 0;
    }

    AtsIcaReleaseHeld();
    [NSThread sleepForTimeInterval:0.05];

    AtsIcaRunner *runner = [[AtsIcaRunner alloc] initWithDest:dest hint:hint];
    runner.mode = AtsIcaModeList;
    runner.holdSessionAfterStage = YES;
    runner.catalogTickCb = tick;
    runner.catalogTickCtx = tick_ctx;

    dispatch_async(dispatch_get_main_queue(), ^{
      [runner startBrowsingOnMain];
    });

    // Release the ICA lock while the catalog streams so thumbnails can use the
    // live session. Download/delete still take the lock exclusively.
    [AtsIcaOpLock() unlock];
    BOOL ok = ats_ica_wait_runner(runner, 90.0, 28.0);
    dispatch_sync(AtsIcaTickQueue(), ^{
    });
    [AtsIcaOpLock() lock];
    runner.catalogTickCb = NULL;
    runner.catalogTickCtx = NULL;
    [AtsIcaOpLock() unlock];

    if (!ok) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage ?: @"Dateiliste über Bildübernahme fehlgeschlagen.");
      return 2;
    }
    return 0;
  }
}

/**
 * Download selected files (newline-separated names; empty = all catalog media)
 * into dest_dir. Prefers the held list/stage session.
 */
int ats_ica_download_named(const char *dest_dir_utf8, const char *name_hint_utf8,
                           const char *names_utf8, ats_ica_progress_cb progress, void *progress_ctx,
                           char *err_buf, size_t err_len) {
  if (!dest_dir_utf8 || !dest_dir_utf8[0]) {
    ats_set_error(err_buf, err_len, @"Kein Zielordner angegeben.");
    return 1;
  }

  [AtsIcaOpLock() lock];
  @autoreleasepool {
    NSString *dest = [NSString stringWithUTF8String:dest_dir_utf8];
    NSString *hint =
        name_hint_utf8 ? [NSString stringWithUTF8String:name_hint_utf8] : @"";
    NSString *raw = names_utf8 ? [NSString stringWithUTF8String:names_utf8] : @"";

    if (ats_ica_held_usable() && g_heldRunner) {
      AtsIcaRunner *runner = g_heldRunner;
      runner.destDir = dest;
      runner.mode = AtsIcaModeStage;
      runner.holdSessionAfterStage = YES;
      runner.catalogConsumed = YES;
      runner.errorMessage = nil;
      runner.pendingFinishAfterClose = NO;
      runner.progressCb = progress;
      runner.progressCtx = progress_ctx;
      [runner.namesToDownload removeAllObjects];
      ats_ica_fill_name_set(runner.namesToDownload, raw);
      [runner.localPaths removeAllObjects];
      runner.downloadIndex = 0;
      [runner.condition lock];
      runner.finished = NO;
      runner.phase = AtsIcaPhaseReady;
      [runner.condition unlock];

      dispatch_async(dispatch_get_main_queue(), ^{
        [runner beginDownloads];
      });

      BOOL ok = ats_ica_wait_runner(runner, 3600.0, 3600.0);
      runner.progressCb = NULL;
      runner.progressCtx = NULL;
      [AtsIcaOpLock() unlock];

      if (!ok) {
        ats_set_error(err_buf, err_len,
                      runner.errorMessage ?: @"USB-Import über Bildübernahme fehlgeschlagen.");
        return 2;
      }
      if (runner.localPaths.count == 0) {
        ats_set_error(err_buf, err_len,
                      runner.errorMessage ?: @"USB-Import über Bildübernahme fehlgeschlagen.");
        return 2;
      }
      return 0;
    }

    AtsIcaReleaseHeld();
    [NSThread sleepForTimeInterval:1.0];

    AtsIcaRunner *runner = [[AtsIcaRunner alloc] initWithDest:dest hint:hint];
    runner.holdSessionAfterStage = YES;
    runner.progressCb = progress;
    runner.progressCtx = progress_ctx;
    ats_ica_fill_name_set(runner.namesToDownload, raw);

    dispatch_async(dispatch_get_main_queue(), ^{
      [runner startBrowsingOnMain];
    });

    BOOL ok = ats_ica_wait_runner(runner, 3600.0, 28.0);
    runner.progressCb = NULL;
    runner.progressCtx = NULL;
    [AtsIcaOpLock() unlock];

    if (!ok) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage ?: @"USB-Import über Bildübernahme fehlgeschlagen.");
      return 2;
    }
    if (runner.localPaths.count == 0) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage ?: @"USB-Import über Bildübernahme fehlgeschlagen.");
      return 2;
    }
    return 0;
  }
}

/**
 * Stage all media (download) into dest_dir. Kept for compatibility; prefers held session.
 */
int ats_ica_stage_all(const char *dest_dir_utf8, const char *name_hint_utf8, char *err_buf,
                      size_t err_len) {
  return ats_ica_download_named(dest_dir_utf8, name_hint_utf8, "", NULL, NULL, err_buf, err_len);
}

/**
 * Delete camera files whose basenames appear in names_utf8 (newline-separated).
 * Prefers the held staging session (same PTP connection). Falls back to a new browse.
 *
 * @param out_deleted optional; number of files reported deleted by Image Capture.
 * @param progress optional; called with (deleted_so_far, matched_total) after each chunk.
 * @return 0 on success (at least one file deleted), non-zero on failure (err_buf set).
 */
int ats_ica_delete_named(const char *name_hint_utf8, const char *names_utf8, int *out_deleted,
                         ats_ica_count_progress_cb progress, void *progress_ctx, char *err_buf,
                         size_t err_len) {
  if (out_deleted) {
    *out_deleted = 0;
  }
  if (!names_utf8 || !names_utf8[0]) {
    ats_set_error(err_buf, err_len, @"Keine Dateinamen für die Kamera-Bereinigung übergeben.");
    return 1;
  }

  [AtsIcaOpLock() lock];
  @autoreleasepool {
    NSString *hint =
        name_hint_utf8 ? [NSString stringWithUTF8String:name_hint_utf8] : @"";
    NSString *raw = [NSString stringWithUTF8String:names_utf8] ?: @"";
    NSArray *parts = [raw componentsSeparatedByCharactersInSet:
                              [NSCharacterSet newlineCharacterSet]];
    NSMutableArray *names = [NSMutableArray array];
    for (NSString *p in parts) {
      NSString *trim =
          [p stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (trim.length > 0) {
        [names addObject:trim];
      }
    }
    if (names.count == 0) {
      [AtsIcaOpLock() unlock];
      ats_set_error(err_buf, err_len, @"Keine Dateinamen für die Kamera-Bereinigung übergeben.");
      return 1;
    }

    NSTimeInterval deleteOverall = MIN(3600.0, MAX(90.0, 8.0 * (double)MAX((NSInteger)names.count, 1)));

    // --- Prefer held staging session (GoPro still connected to Image Capture) ---
    __block BOOL heldUsable = NO;
    if (g_heldRunner) {
      dispatch_sync(dispatch_get_main_queue(), ^{
        heldUsable = g_heldRunner.camera != nil && g_heldRunner.camera.hasOpenSession;
        if (!heldUsable) {
          AtsIcaReleaseHeldOnMain();
        }
      });
    }

    if (heldUsable && g_heldRunner) {
      AtsIcaRunner *runner = g_heldRunner;
      [runner.namesToDelete removeAllObjects];
      for (NSString *n in names) {
        NSString *trim =
            [n stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trim.length > 0) {
          [runner.namesToDelete addObject:[trim lowercaseString]];
        }
      }
      runner.mode = AtsIcaModeDelete;
      runner.holdSessionAfterStage = NO;
      runner.deletedCount = 0;
      runner.matchedCount = 0;
      runner.deletedOkCount = 0;
      runner.deleteOffset = 0;
      runner.deleteChunkGen = 0;
      runner.deleteProgressCb = progress;
      runner.deleteProgressCtx = progress_ctx;
      runner.errorMessage = nil;
      runner.pendingFinishAfterClose = NO;
      [runner.filesToDelete removeAllObjects];
      [runner.condition lock];
      runner.finished = NO;
      runner.phase = AtsIcaPhaseReady;
      [runner.condition unlock];

      dispatch_async(dispatch_get_main_queue(), ^{
        [runner beginDelete];
      });

      BOOL ok = ats_ica_wait_runner(runner, deleteOverall, 30.0);
      runner.deleteProgressCb = NULL;
      runner.deleteProgressCtx = NULL;
      if (g_heldRunner == runner) {
        g_heldRunner = nil;
      }
      runner.sessionHeld = NO;
      [NSThread sleepForTimeInterval:0.15];
      [AtsIcaOpLock() unlock];

      if (!ok) {
        ats_set_error(err_buf, err_len,
                      runner.errorMessage ?: @"Löschen auf der USB-Kamera fehlgeschlagen.");
        return 2;
      }
      if (runner.deletedCount == 0) {
        ats_set_error(err_buf, err_len,
                      runner.errorMessage
                          ?: @"Kamera-Bereinigung meldete Erfolg, aber es wurde nichts gelöscht.");
        return 3;
      }
      if (out_deleted) {
        *out_deleted = (int)runner.deletedCount;
      }
      return 0;
    }

    // --- Fallback: fresh browse when no held staging session ---
    AtsIcaReleaseHeld();
    [NSThread sleepForTimeInterval:0.8];
    AtsIcaRunner *runner = [[AtsIcaRunner alloc] initForDeleteWithHint:hint names:names];
    runner.deleteProgressCb = progress;
    runner.deleteProgressCtx = progress_ctx;

    dispatch_async(dispatch_get_main_queue(), ^{
      [runner startBrowsingOnMain];
    });

    BOOL ok = ats_ica_wait_runner(runner, deleteOverall, 28.0);
    runner.deleteProgressCb = NULL;
    runner.deleteProgressCtx = NULL;
    [NSThread sleepForTimeInterval:0.15];
    [AtsIcaOpLock() unlock];

    if (!ok) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage
                        ?: @"Löschen auf der USB-Kamera fehlgeschlagen. "
                            "Backup ist gespeichert — GoPro nach USB-Import ggf. per "
                            "MicroSD oder an der Kamera bereinigen.");
      return 2;
    }
    if (runner.deletedCount == 0) {
      ats_set_error(err_buf, err_len,
                    runner.errorMessage
                        ?: @"Kamera-Bereinigung meldete Erfolg, aber es wurde nichts gelöscht.");
      return 3;
    }
    if (out_deleted) {
      *out_deleted = (int)runner.deletedCount;
    }
    return 0;
  }
}
