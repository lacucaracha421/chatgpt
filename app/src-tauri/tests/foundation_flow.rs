use std::path::{Path, PathBuf};

use app_lib::library::{
    models::{
        AssetPage, AssetQuery, AssetSummary, ClassificationKind, CreateClassification,
        IngestImageRequest, IngestOutcome,
    },
    Library,
};
use image::{ImageFormat, Rgb, RgbImage};
use tempfile::TempDir;

struct ClassificationPath {
    root_id: String,
    tag_id: String,
}

struct FoundationFixture {
    _temp: TempDir,
    library: Library,
    source_path: PathBuf,
}

impl FoundationFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("arona.png");
        write_image(&source_path, ImageFormat::Png);
        let library = Library::open(temp.path().join("Lakomics Library")).unwrap();
        Self {
            _temp: temp,
            library,
            source_path,
        }
    }

    fn create_game_work_tag(&self) -> ClassificationPath {
        let root = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "게임".into(),
                parent_id: None,
            })
            .unwrap();
        let work = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "블루 아카이브".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let tag = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "아로나".into(),
                parent_id: Some(work.id),
            })
            .unwrap();
        ClassificationPath {
            root_id: root.id,
            tag_id: tag.id,
        }
    }

    fn ingest(&self, classification_id: &str) -> AssetSummary {
        match self.ingest_raw(classification_id) {
            IngestOutcome::Added { asset } => asset,
            IngestOutcome::ExactDuplicate { .. } => panic!("first ingest must add an asset"),
        }
    }

    fn ingest_raw(&self, classification_id: &str) -> IngestOutcome {
        self.library
            .ingest_image(IngestImageRequest {
                source_path: self.source_path.clone(),
                classification_id: Some(classification_id.into()),
                source_url: None,
            })
            .unwrap()
    }

    fn query(&self, classification_id: &str) -> AssetPage {
        self.library
            .list_assets(AssetQuery {
                classification_id: Some(classification_id.into()),
                direct_only: false,
                after: None,
                limit: 100,
            })
            .unwrap()
    }
}

#[test]
fn image_can_be_ingested_classified_queried_and_deduplicated() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let added = fixture.ingest(&classification.tag_id);
    let page = fixture.query(&classification.root_id);

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, added.id);
    assert!(fixture.source_path.is_file());

    let classifications_before = fixture
        .library
        .get_asset_classifications(&added.id)
        .unwrap();
    assert_eq!(classifications_before.len(), 1);
    assert_eq!(classifications_before[0].id, classification.tag_id);
    let duplicate_target = fixture
        .library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Root,
            name: "중복 수집 대상".into(),
            parent_id: None,
        })
        .unwrap();

    let duplicate = fixture.ingest_raw(&duplicate_target.id);
    assert_eq!(
        duplicate,
        IngestOutcome::ExactDuplicate {
            existing_asset_id: added.id.clone(),
        },
    );
    assert_eq!(
        fixture
            .library
            .get_asset_classifications(&added.id)
            .unwrap(),
        classifications_before,
    );
    assert!(fixture.query(&duplicate_target.id).items.is_empty());
    assert_eq!(fixture.query(&classification.root_id), page);
    assert!(fixture.source_path.is_file());
}

#[test]
fn png_jpeg_and_gif_images_can_be_ingested() {
    for (extension, format) in [
        ("png", ImageFormat::Png),
        ("jpg", ImageFormat::Jpeg),
        ("gif", ImageFormat::Gif),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join(format!("source.{extension}"));
        write_image(&source_path, format);
        let library = Library::open(temp.path().join("library")).unwrap();

        let outcome = library
            .ingest_image(IngestImageRequest {
                source_path: source_path.clone(),
                classification_id: None,
                source_url: None,
            })
            .unwrap();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("{extension} must add an asset");
        };
        assert_eq!((asset.width, asset.height), (8, 6));
        assert!(source_path.is_file());
    }
}

fn write_image(path: &Path, format: ImageFormat) {
    RgbImage::from_pixel(8, 6, Rgb([40, 80, 120]))
        .save_with_format(path, format)
        .unwrap();
}
