# FFmpeg third-party notice

Lakomics의 Windows 영상 기능은 FFmpeg와 FFprobe를 별도 sidecar 실행 파일로 배포합니다.

- Project: FFmpeg
- Build provider: BtbN/FFmpeg-Builds
- Release: `autobuild-2026-08-08-13-06`
- Archive: `ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip`
- SHA-256: `4450e09c6740b39777a195569b61cf415a3e7ccaf0eb17f8ac9e16c84787dab3`
- Variant: Windows x86_64, LGPL shared, FFmpeg 7.1 branch
- FFmpeg source revision embedded in the archive name: `1fdbca85aa`

Sources and build instructions:

- FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/1fdbca85aa
- FFmpeg license information: https://ffmpeg.org/legal.html
- Build scripts: https://github.com/BtbN/FFmpeg-Builds
- Pinned binary release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-08-13-06

The selected build is the `lgpl-shared` variant. The fetch script rejects builds whose FFmpeg configuration enables GPL or nonfree components. BtbN's build scripts are MIT-licensed; FFmpeg and its linked libraries retain their respective licenses. Distribution must keep this notice and the upstream license materials available with the application.
