fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=native/macos/AtsImageCapture.m");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=ImageCaptureCore");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        cc::Build::new()
            .file("native/macos/AtsImageCapture.m")
            .flag("-fobjc-arc")
            .compile("ats_image_capture");
    }
    tauri_build::build()
}
