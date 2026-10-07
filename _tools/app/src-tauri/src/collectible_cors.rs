//! Allow the app's own cover rasters to be used in canvas/WebGL.
//! This does not expose the media protocol to arbitrary web origins.
use tauri::http::{header, HeaderValue, Response};

pub(crate) fn allow_cover_canvas(response: &mut Response<Vec<u8>>, origin: Option<&str>, path: &str) {
    let Some(origin) = origin else { return; };
    let packaged = matches!(origin, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost");
    let development = cfg!(debug_assertions) && matches!(origin, "http://localhost:1420" | "http://127.0.0.1:1420");
    // `/asset/` lets the bundled FAULT game read original images as Blobs; still app origins and images only.
    let cover = ["/av-link-jacket/", "/work-artwork/", "/work-artwork-thumbnail/", "/collection-source-thumbnail/", "/thumbnail/", "/asset/"]
        .iter().any(|prefix| path.starts_with(prefix));
    // A vault video's frame is captured from the app's own player for "이 프레임을 썸네일로".
    let vault_video = path.starts_with("/vault-playback/");
    let mime = response.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
    let allowed = (cover && mime.starts_with("image/")) || (vault_video && mime.starts_with("video/"));
    if !(packaged || development) || !allowed || !response.status().is_success() { return; }
    if let Ok(value) = HeaderValue::from_str(origin) {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        response.headers_mut().append(header::VARY, HeaderValue::from_static("Origin"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image() -> Response<Vec<u8>> { Response::builder().header(header::CONTENT_TYPE, "image/png").body(vec![]).unwrap() }
    #[test]
    fn app_cover_can_be_used_as_texture() {
        let mut response = image();
        allow_cover_canvas(&mut response, Some("http://tauri.localhost"), "/work-artwork/id");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://tauri.localhost");
        assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    }
    #[test]
    fn app_can_read_original_images_for_the_game() {
        let mut response = image();
        allow_cover_canvas(&mut response, Some("tauri://localhost"), "/asset/id");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");
    }
    #[test]
    fn unrelated_origins_and_routes_are_not_exposed() {
        for (origin, path) in [("https://example.com", "/work-artwork/id"), ("null", "/work-artwork/id"), ("http://tauri.localhost.evil", "/thumbnail/id"), ("https://example.com", "/asset/id"), ("http://tauri.localhost", "/remote-catalog-thumbnail/id")] {
            let mut response = image(); allow_cover_canvas(&mut response, Some(origin), path);
            assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        }
    }
    #[test]
    fn app_can_capture_a_vault_video_frame_but_nothing_else_of_the_vault() {
        let video = |status: u16| Response::builder().status(status).header(header::CONTENT_TYPE, "video/mp4").body(vec![]).unwrap();
        let mut ranged = video(206);
        allow_cover_canvas(&mut ranged, Some("http://tauri.localhost"), "/vault-playback/id");
        assert_eq!(ranged.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://tauri.localhost");
        for (origin, path) in [("https://example.com", "/vault-playback/id"), ("http://tauri.localhost", "/vault-asset/id"), ("http://tauri.localhost", "/playback/id")] {
            let mut response = video(200);
            allow_cover_canvas(&mut response, Some(origin), path);
            assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN), "{origin}{path}");
        }
        let mut image = image();
        allow_cover_canvas(&mut image, Some("http://tauri.localhost"), "/vault-playback/id");
        assert!(!image.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[test]
    fn failures_and_non_image_responses_stay_unchanged() {
        for (status,mime) in [(404,"image/png"),(200,"application/json")] {
            let mut response = Response::builder().status(status).header(header::CONTENT_TYPE,mime).body(vec![]).unwrap();
            allow_cover_canvas(&mut response, Some("http://tauri.localhost"), "/work-artwork/id");
            assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        }
    }
}
