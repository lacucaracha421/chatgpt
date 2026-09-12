import { publicationProgressText, startPublication, usePublicationJobs } from "../library/publicationJobs";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { catalogStreamStatus } from "../library/catalogStreams";
import type { CatalogLanguage, CatalogStatus, CatalogStreamStatus, CloudCaptureSettings, CloudCaptureSyncResult, CloudLibraryRestoreReport, ExtensionConnection, ExtensionPairingLink, LegacyPackageMigrationPlan, LegacyPackageMigrationReport, MetadataBackup } from "../library/types";
import { formatBytes } from "../assets/assetMetadata";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Select } from "../shared/ui/Select";
import { Toast } from "../shared/ui/Toast";
import { Toggle } from "../shared/ui/Toggle";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { CloudBackfillSettings } from "./CloudBackfillSettings";
import { ExtensionPairingQr } from "./ExtensionPairingQr";
import { CatalogVisibilitySettings } from "./CatalogVisibilitySettings";
import { MobileCatalogPublishSettings } from "./MobileCatalogPublishSettings";
import { APP_ZOOM_LEVELS } from "../preferences/uiPreferences";
import { CharacterAutomationSettings } from "./CharacterAutomationSettings";

type SettingsViewProps = {
  restoring: boolean;
  onRestore: (backupId: string) => Promise<void>;
  onExit: () => void;
  onImportFolder?: (folder: string) => Promise<boolean>;
  metadataImportRunning?: boolean;
  onCollectionsChanged?: () => void;
  onCloudCaptureSynced?: (result: CloudCaptureSyncResult) => void;
  onRestoreCloudMetadata?: () => Promise<CloudLibraryRestoreReport>;
  initialSection?: SettingsSection;
  privacyMode?: boolean;
  onPrivacyModeChange?: (privacyMode: boolean) => void;
  appZoom?: number;
  onAppZoomChange?: (percent: number) => void;
  appZoomError?: string | null;
};

type SettingsSection = "general" | "cloud" | "catalog" | "external_services" | "data" | "about";
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "일반" }, { id: "cloud", label: "클라우드" },
  { id: "catalog", label: "온라인 카탈로그" }, { id: "external_services", label: "연결" },
  { id: "data", label: "데이터 관리" }, { id: "about", label: "정보·도움말" },
];

const METADATA_IMPORT_FOLDER_KEY = "lakomics.metadataImportFolder";

export function SettingsView({ restoring, onRestore, onExit, onImportFolder, metadataImportRunning = false, onCollectionsChanged, onCloudCaptureSynced = () => undefined, onRestoreCloudMetadata, initialSection, privacyMode = false, onPrivacyModeChange = () => undefined, appZoom = 100, onAppZoomChange = () => undefined, appZoomError = null }: SettingsViewProps) {
  const workspace = useWorkspaceChrome();
  const { collections: collectionPublication } = usePublicationJobs();
  const { error: libraryError, gateway, library, openLibrary } = useLibrary();
  const [section, setSection] = useState<SettingsSection>(() => initialSection ?? "general");
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [saved, setSaved] = useState<string | null>(null);
  const [lastImportFolder, setLastImportFolder] = useState(() => localStorage.getItem(METADATA_IMPORT_FOLDER_KEY));
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupRetryVersion, setBackupRetryVersion] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [mangaRoot, setMangaRoot] = useState<string | null>(null);
  const [mangaRootError, setMangaRootError] = useState<string | null>(null);
  const [collectionSourceRoot, setCollectionSourceRootState] = useState<string | null>(null);
  const [collectionSourceError, setCollectionSourceError] = useState<string | null>(null);
  const [collectionSourceMessage, setCollectionSourceMessage] = useState<string | null>(null);
  useAutoDismiss(collectionSourceMessage, setCollectionSourceMessage);
  const [extensionConnection, setExtensionConnection] = useState<ExtensionConnection | null>(null);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [switchingLibrary, setSwitchingLibrary] = useState(false);
  const [characterAutomationBusy, setCharacterAutomationBusy] = useState(false);
  useAutoDismiss(copyMessage, setCopyMessage);
  const [bookImportRunning, setBookImportRunning] = useState(false);
  const [bookImportMessage, setBookImportMessage] = useState<string | null>(null);
  useAutoDismiss(bookImportMessage, setBookImportMessage);
  const [legacyPackage, setLegacyPackage] = useState<{
    packageRoot: string;
    metadataSnapshot: string;
    bookRoot: string;
  } | null>(null);
  const [legacyPlan, setLegacyPlan] = useState<LegacyPackageMigrationPlan | null>(null);
  const [legacyReport, setLegacyReport] = useState<LegacyPackageMigrationReport | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyConfirming, setLegacyConfirming] = useState(false);
  const [kakaoConfigured, setKakaoConfigured] = useState<boolean | null>(null);
  const [kakaoKey, setKakaoKey] = useState("");
  const [kakaoBusy, setKakaoBusy] = useState(false);
  const [kakaoConfirmingDelete, setKakaoConfirmingDelete] = useState(false);
  const [kakaoError, setKakaoError] = useState<string | null>(null);
  const [igdbConfigured, setIgdbConfigured] = useState<boolean | null>(null);
  const [igdbClientId, setIgdbClientId] = useState("");
  const [igdbClientSecret, setIgdbClientSecret] = useState("");
  const [igdbBusy, setIgdbBusy] = useState(false);
  const [igdbConfirmingDelete, setIgdbConfirmingDelete] = useState(false);
  const [igdbError, setIgdbError] = useState<string | null>(null);
  const [tmdbConfigured, setTmdbConfigured] = useState<boolean | null>(null);
  const [tmdbToken, setTmdbToken] = useState("");
  const [tmdbBusy, setTmdbBusy] = useState(false);
  const [tmdbConfirmingDelete, setTmdbConfirmingDelete] = useState(false);
  const [tmdbError, setTmdbError] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogCheckpointConfirming, setCatalogCheckpointConfirming] = useState(false);
  const [catalogRestoreBusy, setCatalogRestoreBusy] = useState(false);
  const [catalogRestoreMessage, setCatalogRestoreMessage] = useState<string | null>(null);
  const [catalogCacheConfirming, setCatalogCacheConfirming] = useState(false);
  const [catalogCacheBusy, setCatalogCacheBusy] = useState(false);
  const [catalogCacheMessage, setCatalogCacheMessage] = useState<string | null>(null);
  const [cloudSettings, setCloudSettings] = useState<CloudCaptureSettings | null>(null);
  const [cloudApiBaseUrl, setCloudApiBaseUrl] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [extensionPairingQr, setExtensionPairingQr] = useState<ExtensionPairingLink | null>(null);
  useAutoDismiss(catalogCacheMessage, setCatalogCacheMessage);
  useAutoDismiss(cloudMessage, setCloudMessage);
  const pending = restoring || submitting || kakaoBusy || igdbBusy || tmdbBusy || cloudBusy || catalogBusy || catalogRestoreBusy || catalogCacheBusy || legacyBusy || bookImportRunning || switchingLibrary || characterAutomationBusy;

  useEffect(() => {
    let active = true;
    if (section === "general") void gateway.getMangaRoot()
      .then((root) => { if (active) setMangaRoot(root); })
      .catch((error) => { if (active) setMangaRootError(commandErrorMessage(error, "망가 폴더를 확인하지 못했습니다.")); });
    if (section === "data") void gateway.getCollectionSourceRoot()
      .then((root) => { if (active) setCollectionSourceRootState(root); })
      .catch((error) => { if (active) setCollectionSourceError(commandErrorMessage(error, "구버전 소스 폴더를 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (section !== "external_services") return;
    let active = true;
    setExtensionConnection(null);
    setExtensionError(null);
    void gateway.getExtensionConnection().then((connection) => {
      if (active) setExtensionConnection(connection);
    }).catch((loadError: unknown) => {
      if (active) setExtensionError(commandErrorMessage(loadError, "확장 프로그램 연결 정보를 불러오지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (section !== "external_services") return;
    let active = true;
    setKakaoConfigured(null);
    setKakaoError(null);
    setIgdbConfigured(null);
    setIgdbError(null);
    setTmdbConfigured(null);
    setTmdbError(null);
    void gateway.getKakaoCredentialStatus().then((status) => {
      if (active) setKakaoConfigured(status.configured);
    }).catch((loadError: unknown) => {
      if (active) setKakaoError(commandErrorMessage(loadError, "카카오 설정을 확인하지 못했습니다."));
    });
    void gateway.getIgdbCredentialStatus().then((status) => {
      if (active) setIgdbConfigured(status.configured);
    }).catch(() => {
      if (active) setIgdbError("IGDB 설정을 확인하지 못했습니다.");
    });
    void gateway.getTmdbCredentialStatus().then((status) => {
      if (active) setTmdbConfigured(status.configured);
    }).catch((loadError: unknown) => {
      if (active) setTmdbError(commandErrorMessage(loadError, "TMDB 설정을 확인하지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (section !== "catalog") return;
    let active = true;
    void gateway.getOnlineCatalogStatus().then((status) => {
      if (active) setCatalogStatus(status);
    }).catch((loadError: unknown) => {
      if (active) setCatalogError(commandErrorMessage(loadError, "온라인 카탈로그 설정을 확인하지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);
  useEffect(() => {
    if (section !== "cloud" && section !== "data") return;
    if (cloudSettings) return;
    let active = true;
    void gateway.getCloudCaptureSettings().then((status) => {
      if (!active) return;
      setCloudSettings(status);
      setCloudApiBaseUrl(status.apiBaseUrl ?? "");
    }).catch((loadError: unknown) => {
      if (active) setCloudError(commandErrorMessage(loadError, "클라우드 설정을 확인하지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (section === "about") void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, [section]);
  useEffect(() => {
    if (section !== "data") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void gateway.listMetadataBackups().then((nextBackups) => {
        if (!controller.signal.aborted) { setBackups(nextBackups); setError(null); }
      }).catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(commandErrorMessage(loadError, "백업 목록을 불러오지 못했습니다."));
      });
    }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [backupRetryVersion, gateway, section]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onExit();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onExit, pending]);

  async function restore() {
    if (!confirmingId || pending) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRestore(confirmingId);
      setConfirmingId(null);
    } catch (restoreError) {
      setError(commandErrorMessage(restoreError, "백업을 복구하지 못했습니다."));
    } finally {
      setSubmitting(false);
    }
  }

  async function chooseLibraryFolder() {
    if (switchingLibrary || pending || metadataImportRunning) return;
    setSwitchingLibrary(true);
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: library?.root });
      if (typeof selected === "string") await openLibrary(selected);
    } finally {
      setSwitchingLibrary(false);
    }
  }

  async function chooseMangaFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      await gateway.setMangaRoot(selected);
      setMangaRoot(selected);
      setSaved("망가 폴더를 저장했습니다");
    } catch (error) {
      setMangaRootError(commandErrorMessage(error, "망가 폴더를 설정하지 못했습니다."));
    }
  }

  async function chooseCollectionSourceFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      const updated = await gateway.setCollectionSourceRoot(selected);
      setCollectionSourceRootState(selected);
      setCollectionSourceError(null);
      setCollectionSourceMessage(
        updated > 0
          ? `레거시 출처를 ${updated}개 컬렉션에 표시했습니다`
          : "컬렉션 소스 폴더를 설정했습니다",
      );
      if (updated > 0) onCollectionsChanged?.();
    } catch (error) {
      setCollectionSourceError(commandErrorMessage(error, "컬렉션 소스 폴더를 설정하지 못했습니다."));
    }
  }

  async function chooseBookImportFolder() {
    if (bookImportRunning) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setBookImportRunning(true);
    setBookImportMessage(null);
    try {
      const report = await gateway.importBookCollections(selected);
      setBookImportMessage(
        `컬렉션 가져오기 완료: 스캔 ${report.scanned}개, 생성 ${report.created}개, 건너뜀 ${report.skipped}개${report.errors.length ? `, 오류 ${report.errors.length}개` : ""}`,
      );
      if (report.created > 0) onCollectionsChanged?.();
    } catch (error) {
      setBookImportMessage(commandErrorMessage(error, "컬렉션을 가져오지 못했습니다."));
    } finally {
      setBookImportRunning(false);
    }
  }

  async function chooseLegacyPackageRoot() {
    if (legacyBusy) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setLegacyPackage((current) => ({ packageRoot: selected, metadataSnapshot: current?.metadataSnapshot ?? "", bookRoot: current?.bookRoot ?? "" }));
  }

  async function chooseLegacyMetadataSnapshot() {
    if (legacyBusy) return;
    const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof selected !== "string") return;
    setLegacyPackage((current) => current ? { ...current, metadataSnapshot: selected } : { packageRoot: "", metadataSnapshot: selected, bookRoot: "" });
  }

  async function chooseLegacyBookRoot() {
    if (legacyBusy) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setLegacyPackage((current) => current ? { ...current, bookRoot: selected } : { packageRoot: "", metadataSnapshot: "", bookRoot: selected });
  }

  async function previewLegacyPackage() {
    if (!legacyPackage || legacyBusy) return;
    if (!legacyPackage.packageRoot || !legacyPackage.metadataSnapshot || !legacyPackage.bookRoot) {
      setLegacyError("패키지 폴더, 메타데이터 스냅샷, book 폴더를 모두 선택하세요.");
      return;
    }
    setLegacyBusy(true);
    setLegacyError(null);
    setLegacyPlan(null);
    setLegacyReport(null);
    try {
      const plan = await gateway.inspectLegacyPackageMigration(legacyPackage);
      setLegacyPlan(plan);
    } catch (error) {
      setLegacyError(commandErrorMessage(error, "레거시 패키지를 검사하지 못했습니다."));
    } finally {
      setLegacyBusy(false);
    }
  }

  async function executeLegacyPackage() {
    if (!legacyPackage || !legacyPlan || legacyBusy) return;
    setLegacyBusy(true);
    setLegacyError(null);
    setLegacyConfirming(false);
    try {
      const report = await gateway.executeLegacyPackageMigration({
        ...legacyPackage,
        expectedFingerprint: legacyPlan.source.fingerprint,
      });
      setLegacyReport(report);
      if (report.added > 0 || report.bookCollections.created > 0) onCollectionsChanged?.();
    } catch (error) {
      setLegacyError(commandErrorMessage(error, "레거시 패키지 자산을 가져오지 못했습니다."));
    } finally {
      setLegacyBusy(false);
    }
  }

  async function copyListExtensionPairing() {
    if (!extensionPairingQr) return;
    try {
      await navigator.clipboard.writeText(extensionPairingQr.pairingUrl);
      setCloudError(null);
      setCloudMessage("연결 링크 복사됨");
    } catch (copyError) {
      setCloudError(commandErrorMessage(copyError, "연결 링크를 복사하지 못했습니다."));
    }
  }

  async function createListExtensionPairing() {
    if (cloudBusy || !gateway.createExtensionPairing) return;
    setCloudBusy(true);
    setCloudError(null);
    try {
      const pairing = await gateway.createExtensionPairing();
      setExtensionPairingQr(pairing);
      try {
        await navigator.clipboard.writeText(pairing.pairingUrl);
        setCloudMessage("연결 링크 복사됨");
      } catch {
        setCloudMessage("QR 생성됨");
      }
    } catch (pairingError) {
      setCloudError(commandErrorMessage(pairingError, "확장 연결 링크를 만들지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function copyExtensionToken() {
    if (!extensionConnection?.token) return;
    try {
      await navigator.clipboard.writeText(extensionConnection.token);
      setExtensionError(null);
      setCopyMessage("연결 키를 복사했습니다");
    } catch (copyError) {
      setCopyMessage(null);
      setExtensionError(commandErrorMessage(copyError, "연결 키를 복사하지 못했습니다."));
    }
  }

  async function saveKakaoKey() {
    if (!kakaoKey.trim() || kakaoBusy) return;
    setKakaoBusy(true);
    setKakaoError(null);
    try {
      const status = await gateway.setKakaoApiKey(kakaoKey);
      setKakaoConfigured(status.configured);
      setKakaoKey("");
      setSaved("카카오 설정을 저장했습니다");
    } catch (saveError) {
      setKakaoError(commandErrorMessage(saveError, "카카오 REST API 키를 저장하지 못했습니다."));
    } finally {
      setKakaoBusy(false);
    }
  }

  async function deleteKakaoKey() {
    if (kakaoBusy) return;
    setKakaoBusy(true);
    setKakaoError(null);
    try {
      const status = await gateway.deleteKakaoApiKey();
      setKakaoConfigured(status.configured);
      setKakaoConfirmingDelete(false);
      setKakaoKey("");
      setSaved("카카오 설정을 저장했습니다");
    } catch (deleteError) {
      setKakaoError(commandErrorMessage(deleteError, "카카오 REST API 키를 삭제하지 못했습니다."));
    } finally {
      setKakaoBusy(false);
    }
  }

  async function saveIgdbCredentials() {
    if (!igdbClientId.trim() || !igdbClientSecret.trim() || igdbBusy) return;
    setIgdbBusy(true);
    setIgdbError(null);
    try {
      const status = await gateway.setIgdbCredentials({ clientId: igdbClientId, clientSecret: igdbClientSecret });
      setIgdbConfigured(status.configured);
      setIgdbClientId("");
      setIgdbClientSecret("");
      setSaved("IGDB 설정을 저장했습니다");
    } catch {
      setIgdbError("IGDB 자격 증명을 저장하지 못했습니다.");
    } finally {
      setIgdbBusy(false);
    }
  }

  async function deleteIgdbCredentials() {
    if (igdbBusy) return;
    setIgdbBusy(true);
    setIgdbError(null);
    try {
      const status = await gateway.deleteIgdbCredentials();
      setIgdbConfigured(status.configured);
      setIgdbConfirmingDelete(false);
      setIgdbClientId("");
      setIgdbClientSecret("");
      setSaved("IGDB 설정을 저장했습니다");
    } catch {
      setIgdbError("IGDB 자격 증명을 삭제하지 못했습니다.");
    } finally {
      setIgdbBusy(false);
    }
  }

  async function saveTmdbToken() {
    const token = tmdbToken.trim();
    if (!token || tmdbBusy) return;
    setTmdbBusy(true);
    setTmdbError(null);
    try {
      const status = await gateway.setTmdbToken(token);
      setTmdbConfigured(status.configured);
      setTmdbToken("");
      setSaved("TMDB 설정을 저장했습니다");
    } catch (saveError) {
      setTmdbError(commandErrorMessage(saveError, "TMDB 토큰을 저장하지 못했습니다."));
    } finally {
      setTmdbBusy(false);
    }
  }

  async function deleteTmdbToken() {
    if (tmdbBusy) return;
    setTmdbBusy(true);
    setTmdbError(null);
    try {
      const status = await gateway.deleteTmdbToken();
      setTmdbConfigured(status.configured);
      setTmdbConfirmingDelete(false);
      setTmdbToken("");
      setSaved("TMDB 설정을 저장했습니다");
    } catch (deleteError) {
      setTmdbError(commandErrorMessage(deleteError, "TMDB 토큰을 삭제하지 못했습니다."));
    } finally {
      setTmdbBusy(false);
    }
  }

  async function saveCloudSettings(enabled = cloudSettings?.enabled ?? false, captureEnabled = cloudSettings?.captureEnabled ?? cloudSettings?.enabled ?? false, saveAddress = false) {
    if (!cloudSettings || cloudBusy) return;
    const apiBaseUrl = saveAddress ? cloudApiBaseUrl.trim() || null : cloudSettings.apiBaseUrl;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const next = await gateway.setCloudCaptureSettings(enabled, apiBaseUrl, captureEnabled);
      setCloudSettings(next);
      if (saveAddress) setCloudApiBaseUrl(next.apiBaseUrl ?? "");
      notifyCloudBackfillSupervisor();
      setCloudMessage("클라우드 설정을 저장했습니다");
    } catch (saveError) {
      setCloudError(commandErrorMessage(saveError, "클라우드 설정을 저장하지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function saveCloudToken() {
    if (!cloudToken.trim() || cloudBusy) return;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const status = await gateway.setCloudApiToken(cloudToken);
      setCloudSettings((current) => current ? { ...current, tokenConfigured: status.configured } : current);
      setCloudToken("");
      setCloudMessage("서버 연결 키을 저장했습니다");
    } catch (saveError) {
      setCloudError(commandErrorMessage(saveError, "서버 연결 키을 저장하지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function deleteCloudToken() {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const status = await gateway.deleteCloudApiToken();
      setCloudSettings((current) => current ? { ...current, tokenConfigured: status.configured } : current);
      setCloudToken("");
      setCloudMessage("서버 연결 키을 삭제했습니다");
    } catch (deleteError) {
      setCloudError(commandErrorMessage(deleteError, "서버 연결 키을 삭제하지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function testCloudConnection() {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const status = await gateway.testCloudCaptureConnection();
      setCloudMessage(`Cloud 연결 정상 · 대기 ${status.pendingCount.toLocaleString()}건`);
    } catch (connectionError) {
      setCloudError(commandErrorMessage(connectionError, "Cloud Capture 연결에 실패했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function pushCloudCollections() {
    if (cloudBusy || !gateway.pushCloudCollections) return;
    await startPublication("collections", progress => gateway.pushCloudCollections!(progress),
      result => `${result.collections.toLocaleString()}개 완료 · 이미지 업로드 ${result.uploaded.toLocaleString()}개`);
  }

  async function pushCloudMetadataBackup() {
    if (cloudBusy) return;
    if (!gateway.pushCloudMetadataBackup) {
      setCloudError("현재 앱 빌드에서는 서버 메타데이터 백업을 지원하지 않습니다.");
      return;
    }
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const result = await gateway.pushCloudMetadataBackup();
      setCloudMessage(`메타데이터 서버 백업 완료 · ${formatBytes(result.byteSize)}`);
    } catch (backupError) {
      setCloudError(commandErrorMessage(backupError, "메타데이터를 서버에 백업하지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function restoreCloudMetadataBackup() {
    if (cloudBusy) return;
    if (!onRestoreCloudMetadata && !gateway.restoreCloudMetadataBackup) {
      setCloudError("현재 앱 빌드에서는 서버 메타데이터 복원을 지원하지 않습니다.");
      return;
    }
    if (!window.confirm("서버의 최신 복구 지점으로 현재 PC 라이브러리를 복원할까요? 현재 DB는 pre-restore 백업으로 먼저 보존되고, 관리 에셋은 R2에서 다시 내려받습니다.")) return;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const report = onRestoreCloudMetadata
        ? await onRestoreCloudMetadata()
        : await gateway.restoreCloudMetadataBackup!();
      setCloudMessage(
        `서버 복원 완료 · 원본 ${report.originalsRestored.toLocaleString()} · 썸네일 ${report.thumbnailsRestored.toLocaleString()} · `
        + `건너뜀 ${report.filesSkipped.toLocaleString()} · 서버 미보유 ${report.filesUnavailable.toLocaleString()} · ${formatBytes(report.bytesDownloaded)}`,
      );
      setBackupRetryVersion((current) => current + 1);
    } catch (restoreError) {
      setCloudError(commandErrorMessage(restoreError, "서버 메타데이터를 복원하지 못했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function syncCloudNow() {
    if (cloudBusy) return;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const result = await gateway.runDueCloudCaptureSync();
      onCloudCaptureSynced(result);
      setCloudMessage(`Cloud 동기화 완료 · 추가 ${result.added} · 검토 ${result.reviewPending} · 실패 ${result.failed}`);
    } catch (syncError) {
      setCloudError(commandErrorMessage(syncError, "Cloud Capture 동기화에 실패했습니다."));
    } finally {
      setCloudBusy(false);
    }
  }

  async function saveCatalogSettings(enabled: boolean, intervalSeconds: number) {
    if (!catalogStatus || catalogBusy) return;
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      setCatalogStatus(await gateway.setOnlineCatalogUpdateSettings(enabled, intervalSeconds));
      setSaved("자동 갱신 설정을 저장했습니다");
    } catch (saveError) {
      setCatalogError(commandErrorMessage(saveError, "온라인 카탈로그 설정을 저장하지 못했습니다."));
    } finally {
      setCatalogBusy(false);
    }
  }

  async function updateCatalogStream(language: CatalogLanguage, maxPages: number) {
    if (!catalogStatus || catalogBusy) return;
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      await gateway.updateOnlineCatalog(language, maxPages);
      setCatalogStatus(await gateway.getOnlineCatalogStatus());
    } catch (updateError) {
      setCatalogError(commandErrorMessage(updateError, `${catalogLanguageLabel(language)} 카탈로그를 갱신하지 못했습니다.`));
    } finally {
      setCatalogBusy(false);
    }
  }

  async function resetJapaneseCatalogCheckpoint() {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      setCatalogStatus(await gateway.resetJapaneseCatalogCheckpoint());
      setCatalogCheckpointConfirming(false);
    } catch (resetError) {
      setCatalogError(commandErrorMessage(resetError, "일본어 카탈로그 체크포인트를 재설정하지 못했습니다."));
    } finally {
      setCatalogBusy(false);
    }
  }

  async function restoreCatalogFromVck() {
    if (catalogRestoreBusy) return;
    setCatalogRestoreBusy(true);
    setCatalogError(null);
    setCatalogRestoreMessage(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      const next = await gateway.importVckCatalog(selected);
      setCatalogStatus(next);
      setCatalogRestoreMessage(`카탈로그를 교체했습니다 · ${next.workCount.toLocaleString()}개 작품`);
    } catch (restoreError) {
      setCatalogError(commandErrorMessage(restoreError, "VCK 카탈로그를 교체하지 못했습니다. 기존 카탈로그가 유지됩니다."));
    } finally {
      setCatalogRestoreBusy(false);
    }
  }

  async function clearCatalogCache() {
    if (catalogCacheBusy) return;
    setCatalogCacheBusy(true);
    setCatalogError(null);
    setCatalogCacheMessage(null);
    try {
      await gateway.clearRemoteMangaCache();
      setCatalogCacheConfirming(false);
      setCatalogCacheMessage("온라인 이미지 캐시를 지웠습니다");
    } catch (clearError) {
      setCatalogError(commandErrorMessage(clearError, "온라인 이미지 캐시를 지우지 못했습니다."));
    } finally {
      setCatalogCacheBusy(false);
    }
  }

  async function chooseImportFolder() {
    const selected = await open({ directory: true, multiple: false, defaultPath: localStorage.getItem(METADATA_IMPORT_FOLDER_KEY) ?? undefined });
    if (typeof selected !== "string") return;
    if (await onImportFolder?.(selected)) {
      localStorage.setItem(METADATA_IMPORT_FOLDER_KEY, selected);
      setLastImportFolder(selected);
    }
  }

  const navigation = <nav className="settings-view__navigation" aria-label="설정 구역">
    {SECTIONS.map(({ id, label }) => <Button key={id} className="settings-view__section-button" variant="ghost" aria-current={section === id ? "page" : undefined} onClick={() => { setSection(id); setSaved(null); }}>{label}</Button>)}
  </nav>;
  return <section className="settings-view" aria-label="설정" >
    <ViewToolbar title={`설정 · ${SECTIONS.find((item) => item.id === section)?.label}`} chrome={{ navigation }} />
    <div className={`settings-view__body${workspace ? " settings-view__body--integrated" : ""}`}>
    {!workspace && navigation}
    <div className="settings-view__content" key={section}>
    {saved && <p className="settings-view__saved" role="status">{saved}</p>}
    {section === "general" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>일반</h2></header>
        <dl className="settings-view__property">
          <dt>화면 배율</dt>
          <dd className="settings-view__credential-status">글자, 버튼, 이미지 등 앱 전체 크기를 조절합니다. 변경 즉시 적용되며 다음 실행에도 유지됩니다.</dd>
          <dd className="settings-view__inline-controls"><Select label="앱 전체 배율" value={appZoom} onChange={(event) => onAppZoomChange(Number(event.target.value))}>
            {APP_ZOOM_LEVELS.map(level => <option key={level} value={level}>{level}%{level === 100 ? " (기본)" : ""}</option>)}
          </Select>
          <Button size="sm" disabled={appZoom === 100} onClick={() => onAppZoomChange(100)}>100%로 복원</Button></dd>
          {appZoomError && <dd role="alert">{appZoomError}</dd>}
        </dl>
        <dl className="settings-view__property">
          <dt>비공개 모드</dt>
          <dd className="settings-view__credential-status">모든 이미지와 영상을 자리표시로 가립니다. 화면 공유 중에 내용이 보이지 않습니다.</dd>
          <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => { onPrivacyModeChange(event.target.checked); setSaved("비공개 모드 설정을 저장했습니다"); }}>켜기</Toggle>
        </dl>
        {library && <CharacterAutomationSettings key={library.root} disabled={pending} onBusyChange={setCharacterAutomationBusy} />}
        <dl className="settings-view__property">
          <dt>라이브러리 폴더</dt>
          <dd className="settings-view__path">{library?.root ?? "알 수 없음"}</dd>
          <Button size="sm" disabled={switchingLibrary || pending || metadataImportRunning} onClick={() => void chooseLibraryFolder()}>
            {switchingLibrary ? "여는 중…" : "다른 저장소 열기"}
          </Button>
          {libraryError && <dd className="settings-view__row-message" role="alert">{libraryError}</dd>}
        </dl>


        <dl className="settings-view__property">
          <dt>망가 폴더</dt>
          <dd className="settings-view__path">{mangaRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" onClick={() => void chooseMangaFolder()}>변경</Button>
          {mangaRootError && <dd className="settings-view__row-message" role="alert">{mangaRootError}</dd>}
        </dl>
      </div>
    )}
    {section === "about" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>정보·도움말</h2></header>
        <dl className="settings-view__property">
          <dt>앱 버전</dt>
          <dd>{appVersion ?? "알 수 없음"}</dd>
        </dl>
        <h3 className="settings-view__group-title">단축키</h3>
        <table className="settings-view__table">
          <thead><tr><th scope="col">단축키</th><th scope="col">동작</th></tr></thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => <tr key={shortcut.keys}><td><kbd>{shortcut.keys}</kbd></td><td>{shortcut.action}</td></tr>)}
          </tbody>
        </table>
      </div>
    )}
        {section === "external_services" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>연결</h2></header>
        {kakaoError && <Toast tone="error" onDismiss={() => setKakaoError(null)}>{kakaoError}</Toast>}
        {igdbError && <Toast tone="error" onDismiss={() => setIgdbError(null)}>{igdbError}</Toast>}
        {tmdbError && <Toast tone="error" onDismiss={() => setTmdbError(null)}>{tmdbError}</Toast>}
        <h3 className="settings-view__group-title">브라우저 확장</h3>
        {extensionError && <Toast tone="error" onDismiss={() => setExtensionError(null)}>{extensionError}</Toast>}
        {!extensionConnection && !extensionError ? (
          <Skeleton className="settings-view__skeleton" label="확장 프로그램 연결 정보를 불러오는 중" />
        ) : extensionConnection ? (
          <>
            <dl className="settings-view__property">
              <dt>연결 상태</dt>
              <dd>{extensionConnection.status === "ready" ? "PC 연결 준비됨" : "사용 불가"}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>로컬 주소</dt>
              <dd className="settings-view__path">{extensionConnection.baseUrl}</dd>
            </dl>
            <label className="settings-view__property">
              <span className="settings-view__property-label">연결 키</span>
              <span className="settings-view__token-row">
                <input
                  className="settings-view__token"
                  aria-label="확장 프로그램 연결 키"
                  type="password"
                  readOnly
                  value={extensionConnection.token}
                />
                <Button
                  size="sm"
                  disabled={!extensionConnection.token}
                  onClick={() => void copyExtensionToken()}
                >연결 키 복사</Button>
              </span>
            </label>
            {copyMessage && <Toast onDismiss={() => setCopyMessage(null)}>{copyMessage}</Toast>}
          </>
        ) : null}
        <h3 className="settings-view__group-title">작품 정보 서비스</h3>
        <dl className="settings-view__property settings-view__property--credential">
          <dt>카카오 책 검색</dt>
          <dd>
            <span className="settings-view__token-row">
              <input
                className="settings-view__token"
                aria-label="카카오 REST API 키"
                type="password"
                autoComplete="off"
                placeholder={kakaoConfigured === null ? "확인 중…" : kakaoConfigured ? "설정됨" : "설정되지 않음"}
                value={kakaoKey}
                onChange={(event) => { setKakaoKey(event.target.value); setSaved(null); }}
              />
              <Button size="sm" disabled={kakaoBusy || !kakaoKey.trim()} onClick={() => void saveKakaoKey()}>{kakaoBusy ? "처리 중…" : "저장"}</Button>
            </span>
          </dd>
          {kakaoConfigured && !kakaoConfirmingDelete && <Button size="sm" variant="danger" disabled={kakaoBusy} onClick={() => setKakaoConfirmingDelete(true)}>키 삭제</Button>}
        </dl>
        {kakaoConfirmingDelete && (
          <div className="settings-view__credential-confirm">
            <p>저장된 카카오 REST API 키를 삭제할까요?</p>
            <div className="settings-view__credential-actions">
              <Button size="sm" disabled={kakaoBusy} onClick={() => setKakaoConfirmingDelete(false)}>취소</Button>
              <Button size="sm" variant="danger" disabled={kakaoBusy} onClick={() => void deleteKakaoKey()}>삭제 확인</Button>
            </div>
          </div>
        )}
        <dl className="settings-view__property settings-view__property--credential">
          <dt>IGDB</dt>
          <dd>
            <span className="settings-view__token-row">
              <input
                className="settings-view__token"
                aria-label="IGDB Client ID"
                type="password"
                autoComplete="off"
                placeholder={igdbConfigured === null ? "확인 중…" : igdbConfigured ? "설정됨" : "설정되지 않음"}
                value={igdbClientId}
                onChange={(event) => { setIgdbClientId(event.target.value); setSaved(null); }}
              />
              <input
                className="settings-view__token"
                aria-label="IGDB Client Secret"
                type="password"
                autoComplete="off"
                placeholder={igdbConfigured === null ? "확인 중…" : igdbConfigured ? "설정됨" : "설정되지 않음"}
                value={igdbClientSecret}
                onChange={(event) => { setIgdbClientSecret(event.target.value); setSaved(null); }}
              />
              <Button size="sm" disabled={igdbBusy || !igdbClientId.trim() || !igdbClientSecret.trim()} onClick={() => void saveIgdbCredentials()}>{igdbBusy ? "처리 중…" : "IGDB 저장"}</Button>
            </span>
          </dd>
          {igdbConfigured && !igdbConfirmingDelete && <Button size="sm" variant="danger" disabled={igdbBusy} onClick={() => setIgdbConfirmingDelete(true)}>IGDB 키 삭제</Button>}
        </dl>
        {igdbConfirmingDelete && (
          <div className="settings-view__credential-confirm">
            <p>저장된 IGDB 자격 증명을 삭제할까요?</p>
            <div className="settings-view__credential-actions">
              <Button size="sm" disabled={igdbBusy} onClick={() => setIgdbConfirmingDelete(false)}>취소</Button>
              <Button size="sm" variant="danger" disabled={igdbBusy} onClick={() => void deleteIgdbCredentials()}>IGDB 삭제 확인</Button>
            </div>
          </div>
        )}
        <dl className="settings-view__property settings-view__property--credential">
          <dt>TMDB</dt>
          <dd>
            <span className="settings-view__token-row">
              <input
                className="settings-view__token"
                aria-label="TMDB API Read Access Token"
                type="password"
                autoComplete="off"
                placeholder={tmdbConfigured === null ? "확인 중…" : tmdbConfigured ? "설정됨" : "설정되지 않음"}
                value={tmdbToken}
                onChange={(event) => { setTmdbToken(event.target.value); setSaved(null); }}
              />
              <Button size="sm" disabled={tmdbBusy || !tmdbToken.trim()} onClick={() => void saveTmdbToken()}>{tmdbBusy ? "처리 중…" : "TMDB 저장"}</Button>
            </span>
          </dd>
          {tmdbConfigured && !tmdbConfirmingDelete && <Button size="sm" variant="danger" disabled={tmdbBusy} onClick={() => setTmdbConfirmingDelete(true)}>TMDB 키 삭제</Button>}
        </dl>
        {tmdbConfirmingDelete && (
          <div className="settings-view__credential-confirm">
            <p>저장된 TMDB API Read Access Token을 삭제할까요?</p>
            <div className="settings-view__credential-actions">
              <Button size="sm" disabled={tmdbBusy} onClick={() => setTmdbConfirmingDelete(false)}>취소</Button>
              <Button size="sm" variant="danger" disabled={tmdbBusy} onClick={() => void deleteTmdbToken()}>TMDB 삭제 확인</Button>
            </div>
          </div>
        )}
        <p className="settings-view__row-note">TMDB API 키는 <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">TMDB API 설정 안내</a>에서 발급합니다.</p>
      </div>
    )}
    {section === "cloud" && <div className="settings-view__section">
      <header className="settings-view__header"><h2>클라우드</h2></header>
      {cloudError && <Toast tone="error" onDismiss={() => setCloudError(null)}>{cloudError}</Toast>}
      {cloudBusy ? <p role="status">처리 중…</p> : cloudMessage && <p role="status">{cloudMessage}</p>}

        {!cloudSettings ? (
          <Skeleton className="settings-view__skeleton" label="클라우드 설정을 불러오는 중" />
        ) : (
          <>
            <dl className="settings-view__property">
              <dt>클라우드 → PC</dt>
              <dd><Toggle checked={cloudSettings.captureEnabled ?? cloudSettings.enabled} disabled={cloudBusy || !cloudSettings.apiBaseUrl} onChange={(event) => void saveCloudSettings(cloudSettings.enabled, event.target.checked)}>자동 수신</Toggle></dd>
              <dd className="settings-view__row-note">브라우저에서 클라우드로 수집한 자료를 PC로 가져옵니다.</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>PC → 클라우드</dt>
              <dd><Toggle checked={cloudSettings.enabled} disabled={cloudBusy || !cloudSettings.apiBaseUrl} onChange={(event) => void saveCloudSettings(event.target.checked)}>자동 복제</Toggle></dd>
              <dd className="settings-view__row-note">끄면 진행 중인 전송을 마친 뒤 멈춥니다. 저장된 사본과 대기 자료는 유지됩니다.</dd>
            </dl>
            <details className="settings-view__advanced"><summary>서버 연결 설정</summary>
            <dl className="settings-view__property">
              <dt>서버 주소{cloudApiBaseUrl.trim() !== (cloudSettings.apiBaseUrl ?? "") && <span className="settings-view__row-note"> · 저장 전</span>}</dt>
              <dd className="settings-view__token-row">
                <input className="settings-view__token" aria-label="서버 주소" type="url" autoComplete="off" placeholder="http://100.x.x.x:32146" value={cloudApiBaseUrl} onChange={(event) => { setCloudApiBaseUrl(event.target.value); setCloudMessage(null); }} />
                <Button size="sm" disabled={cloudBusy || ((cloudSettings.enabled || cloudSettings.captureEnabled) && !cloudApiBaseUrl.trim())} onClick={() => void saveCloudSettings(cloudSettings.enabled, cloudSettings.captureEnabled ?? cloudSettings.enabled, true)}>저장</Button>
              </dd>
            </dl>
            <dl className="settings-view__property">
              <dt>연결 키</dt>
              <dd className="settings-view__token-row">
                <input className="settings-view__token" aria-label="서버 연결 키" type="password" autoComplete="off" placeholder={cloudSettings.tokenConfigured ? "설정됨" : "설정되지 않음"} value={cloudToken} onChange={(event) => { setCloudToken(event.target.value); setCloudMessage(null); }} />
                <Button size="sm" disabled={cloudBusy || !cloudToken.trim()} onClick={() => void saveCloudToken()}>토큰 저장</Button>
                {cloudSettings.tokenConfigured && <Button size="sm" variant="danger" disabled={cloudBusy} onClick={() => void deleteCloudToken()}>토큰 삭제</Button>}
              </dd>
            </dl>
            </details>
            <div className="settings-view__actions">
              <Button size="sm" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured || !gateway.createExtensionPairing} onClick={() => void createListExtensionPairing()}>확장 연결</Button>
              <Button size="sm" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void testCloudConnection()}>연결 확인</Button>
              <Button size="sm" variant="primary" disabled={cloudBusy || !(cloudSettings.captureEnabled ?? cloudSettings.enabled) || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void syncCloudNow()}>지금 수신</Button>
            </div>
            {extensionPairingQr && (
              <ExtensionPairingQr
                value={extensionPairingQr}
                onCopy={copyListExtensionPairing}
                onRefresh={createListExtensionPairing}
                onClose={() => setExtensionPairingQr(null)}
              />
            )}

          </>
        )}
        <CloudBackfillSettings />
    </div>}
    {section === "catalog" && <div className="settings-view__section">
      <header className="settings-view__header"><h2>온라인 카탈로그</h2></header>
      {catalogError && <Toast tone="error" onDismiss={() => setCatalogError(null)}>{catalogError}</Toast>}

        {catalogStatus && <dl className="settings-view__property">
          <dt>카탈로그 상태</dt>
          <dd>{catalogStatus.installed ? `설치됨 · ${catalogStatus.workCount.toLocaleString()}개 작품` : "미설치"}</dd>
        </dl>}

        {catalogStatus && <dl className="settings-view__property">
          <dt>온라인 카탈로그</dt>
          <dd><Toggle checked={catalogStatus.updateEnabled} disabled={catalogBusy || !catalogStatus.installed} onChange={(event) => void saveCatalogSettings(event.target.checked, catalogStatus.updateIntervalSeconds)}>자동 갱신</Toggle></dd>
          <Select label="갱신 간격" value={String(catalogStatus.updateIntervalSeconds)} disabled={catalogBusy || !catalogStatus.installed} onChange={(event) => void saveCatalogSettings(catalogStatus.updateEnabled, Number(event.target.value))}>
            <option value="3600">1시간</option>
            <option value="21600">6시간</option>
            <option value="86400">24시간</option>
          </Select>
        </dl>}
        <CatalogVisibilitySettings />
        <MobileCatalogPublishSettings />
        <dl className="settings-view__property">
          <dt>온라인 이미지 캐시</dt>
          <dd>열어 본 온라인 작품의 페이지 이미지만 삭제합니다.</dd>
          {!catalogCacheConfirming ? (
            <Button size="sm" disabled={catalogCacheBusy} onClick={() => setCatalogCacheConfirming(true)}>이미지 캐시 지우기</Button>
          ) : (
            <span className="settings-view__credential-actions">
              <Button size="sm" disabled={catalogCacheBusy} onClick={() => setCatalogCacheConfirming(false)}>취소</Button>
              <Button size="sm" variant="danger" disabled={catalogCacheBusy} onClick={() => void clearCatalogCache()}>
                {catalogCacheBusy ? "삭제 중…" : "캐시 삭제 확인"}
              </Button>
            </span>
          )}
        </dl>
        <details className="settings-view__advanced"><summary>수집 상세·카탈로그 복구</summary>
        {catalogStatus?.installed && <>
          <CatalogStreamSettings
            stream={catalogStreamStatus(catalogStatus, "korean")}
            busy={catalogBusy}
            onUpdate={updateCatalogStream}
          />
          <CatalogStreamSettings
            stream={catalogStreamStatus(catalogStatus, "japanese")}
            busy={catalogBusy}
            onUpdate={updateCatalogStream}
          />
          <dl className="settings-view__property">
            <dt>일본어 체크포인트</dt>
            <dd className="settings-view__row-note">초기 수집 위치만 재설정하며 기존 카탈로그와 사용자 데이터는 유지합니다.</dd>
            {!catalogCheckpointConfirming ? (
              <Button size="sm" disabled={catalogBusy} onClick={() => setCatalogCheckpointConfirming(true)}>일본어 체크포인트 재설정</Button>
            ) : (
              <span className="settings-view__credential-actions">
                <Button size="sm" disabled={catalogBusy} onClick={() => setCatalogCheckpointConfirming(false)}>취소</Button>
                <Button size="sm" variant="danger" disabled={catalogBusy} onClick={() => void resetJapaneseCatalogCheckpoint()}>체크포인트 재설정 확인</Button>
              </span>
            )}
            {catalogCheckpointConfirming && <dd className="settings-view__row-message">일본어 카탈로그 체크포인트만 재설정할까요? 기존 카탈로그와 북마크·읽기 기록은 그대로 유지됩니다.</dd>}
          </dl>
        </>}
        {catalogStatus?.installed && <dl className="settings-view__property">
          <dt>카탈로그 교체·복구</dt>
          <dd className="settings-view__row-note">VCK 원본 폴더를 다시 선택하면 검증 후 전체 카탈로그를 교체합니다. 북마크와 읽기 기록은 유지됩니다.</dd>
          <Button size="sm" disabled={catalogRestoreBusy} onClick={() => void restoreCatalogFromVck()}>
            {catalogRestoreBusy ? "교체 중…" : "VCK 폴더 다시 선택"}
          </Button>
          {catalogRestoreMessage && <dd className="settings-view__row-message">{catalogRestoreMessage}</dd>}
        </dl>}
        </details>
        {catalogCacheMessage && <Toast onDismiss={() => setCatalogCacheMessage(null)}>{catalogCacheMessage}</Toast>}
    </div>}
    {section === "data" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>데이터 관리</h2></header>
        <h3 className="settings-view__group-title">컬렉션 가져오기</h3>
        <dl className="settings-view__property">
          <dt>book 폴더</dt>
          <dd className="settings-view__path">book 폴더의 info.txt에서 게임/만화/영화 컬렉션을 가져옵니다.</dd>
          <Button size="sm" disabled={bookImportRunning} onClick={() => void chooseBookImportFolder()}>
            {bookImportRunning ? "가져오는 중…" : "폴더 선택"}
          </Button>
          {bookImportMessage && <dd className="settings-view__row-message" role="alert">{bookImportMessage}</dd>}
        </dl>
        <h3 className="settings-view__group-title">메타데이터 가져오기</h3>
        <dl className="settings-view__property">
          <dt>최근 가져오기 폴더</dt>
          <dd className="settings-view__path">{lastImportFolder ?? "아직 없음"}</dd>
          <span className="settings-view__credential-actions">
            {lastImportFolder && <Button size="sm" disabled={pending || metadataImportRunning || !onImportFolder} onClick={() => void onImportFolder?.(lastImportFolder)}>최근 폴더 다시 가져오기</Button>}
            <Button size="sm" variant="primary" disabled={pending || metadataImportRunning || !onImportFolder} onClick={() => void chooseImportFolder()}>{lastImportFolder ? "다른 폴더 선택" : "폴더 선택"}</Button>
          </span>
        </dl>
        <details className="settings-view__advanced"><summary>구버전 자료 가져오기</summary>
        <dl className="settings-view__property">
          <dt>컬렉션 소스 폴더</dt>
          <dd className="settings-view__path">{collectionSourceRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" aria-label="컬렉션 소스 폴더 변경" onClick={() => void chooseCollectionSourceFolder()}>변경</Button>
          <dd className="settings-view__row-note">구버전 book 소스 위치입니다. info.txt로 컬렉션 출처를 판별할 때 사용합니다.</dd>
          {collectionSourceError && <dd className="settings-view__row-message" role="alert">{collectionSourceError}</dd>}
        </dl>
        {collectionSourceMessage && <Toast onDismiss={() => setCollectionSourceMessage(null)}>{collectionSourceMessage}</Toast>}
        <h3 className="settings-view__group-title">레거시 패키지 가져오기</h3>
        {legacyError && <Toast tone="error" onDismiss={() => setLegacyError(null)}>{legacyError}</Toast>}
        <dl className="settings-view__property">
          <dt>패키지 폴더</dt>
          <dd className="settings-view__path">{legacyPackage?.packageRoot ?? "선택되지 않음"}</dd>
          <Button size="sm" disabled={legacyBusy} onClick={() => void chooseLegacyPackageRoot()}>선택</Button>
        </dl>
        <dl className="settings-view__property">
          <dt>메타데이터 스냅샷</dt>
          <dd className="settings-view__path">{legacyPackage?.metadataSnapshot ?? "선택되지 않음"}</dd>
          <Button size="sm" disabled={legacyBusy} onClick={() => void chooseLegacyMetadataSnapshot()}>선택</Button>
        </dl>
        <dl className="settings-view__property">
          <dt>Book 폴더</dt>
          <dd className="settings-view__path">{legacyPackage?.bookRoot ?? "선택되지 않음"}</dd>
          <Button size="sm" disabled={legacyBusy} onClick={() => void chooseLegacyBookRoot()}>선택</Button>
        </dl>
        <div className="settings-view__actions">
          <Button disabled={legacyBusy || !legacyPackage} onClick={() => void previewLegacyPackage()}>{legacyBusy ? "검사 중…" : "미리 보기"}</Button>
        </div>
        {legacyBusy && (
          <p className="settings-view__row-message" role="status">패키지를 검사하는 중입니다. 파일이 많으면 시간이 걸려요…</p>
        )}
        {legacyPlan && (
          <div className="settings-view__legacy-plan">
            <h3 className="settings-view__group-title">검사 결과</h3>
            <dl className="settings-view__property">
              <dt>라이브러리 ID</dt>
              <dd className="settings-view__path">{legacyPlan.source.libraryId}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>패키지 자산</dt>
              <dd>이미지 {legacyPlan.source.imageCount}개 · 영상 {legacyPlan.source.videoCount}개 · 즐겨찾기 {legacyPlan.source.favoriteCount}개</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>가져올 자산</dt>
              <dd>새 자산 {legacyPlan.preview.newAssets}개 · 대상 중복 {legacyPlan.preview.exactTargetDuplicates}개 · 이미 매핑 {legacyPlan.preview.alreadyMapped}개</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>분류</dt>
              <dd>생성 {legacyPlan.preview.foldersToCreate} · 재사용 {legacyPlan.preview.foldersReused}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>컬렉션</dt>
              <dd>생성 {legacyPlan.preview.collectionsToCreate} · 기존 {legacyPlan.preview.collectionsExisting} · 오류 {legacyPlan.preview.collectionErrors}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>예상 복사량</dt>
              <dd>{formatBytes(legacyPlan.preview.estimatedCopyBytes)}</dd>
            </dl>
            {!legacyConfirming ? (
              <div className="settings-view__actions">
                <Button variant="primary" disabled={legacyBusy} onClick={() => setLegacyConfirming(true)}>가져오기 실행</Button>
              </div>
            ) : (
              <div className="settings-view__safety-confirm">
                <p>레거시 패키지 자산을 현재 라이브러리로 가져올까요? 새 자산은 복사되고, 기존 자산은 메타데이터만 병합됩니다.</p>
                <div className="ui-dialog__actions">
                  <Button disabled={legacyBusy} onClick={() => setLegacyConfirming(false)}>취소</Button>
                  <Button variant="primary" disabled={legacyBusy} onClick={() => void executeLegacyPackage()}>{legacyBusy ? "가져오는 중…" : "가져오기 확인"}</Button>
                </div>
              </div>
            )}
          </div>
        )}
        {legacyReport && (
          <div className="settings-view__legacy-report">
            <h3 className="settings-view__group-title">가져오기 결과</h3>
            <dl className="settings-view__property">
              <dt>자산</dt>
              <dd>추가 {legacyReport.added} · 대상 재사용 {legacyReport.exactTargetReused} · 중복 재사용 {legacyReport.sourceDuplicatesReused} · 이미 매핑 {legacyReport.alreadyMapped} · 실패 {legacyReport.failed}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>분류</dt>
              <dd>생성 {legacyReport.foldersCreated} · 재사용 {legacyReport.foldersReused} · 연결 추가 {legacyReport.classificationLinksAdded}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>컬렉션</dt>
              <dd>생성 {legacyReport.bookCollections.created} · 건너뜀 {legacyReport.bookCollections.skipped}</dd>
            </dl>
            {legacyReport.failures.length > 0 && (
              <ul className="settings-view__legacy-failures">
                {legacyReport.failures.map((failure) => (
                  <li key={failure.sourceItemId}><strong>{failure.sourceItemId}</strong> — {failure.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        </details>
        <h3 className="settings-view__group-title">서버 백업·복원</h3>
        {cloudError && <Toast tone="error" onDismiss={() => setCloudError(null)}>{cloudError}</Toast>}
        {cloudBusy ? <p role="status">처리 중…</p> : cloudMessage && <p role="status">{cloudMessage}</p>}
        {cloudSettings && <>            <dl className="settings-view__property">
              <dt>PC 복구 지점</dt>
              <dd className="settings-view__row-note">라이브러리 관리 정보를 서버에 백업합니다. 복원 시 서버에 보관된 자료도 내려받습니다. 외부 망가 폴더는 포함되지 않습니다.</dd>
              <dd className="settings-view__actions">
                <Button size="sm" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void pushCloudMetadataBackup()}>서버 복구 지점 만들기</Button>
                <Button size="sm" variant="danger" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void restoreCloudMetadataBackup()}>서버에서 PC 복원</Button>
              </dd>
            </dl></>}
        {cloudSettings && <dl className="settings-view__property">
          <dt>모바일 컬렉션</dt>
          <dd className="settings-view__row-note">현재 PC의 컬렉션 정보와 보관된 이미지를 서버에 게시합니다. PC가 꺼져 있어도 모바일에서 감상할 수 있습니다.</dd>
          <dd className="settings-view__actions">
            <Button size="sm" disabled={cloudBusy || collectionPublication?.running || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured || !gateway.pushCloudCollections} onClick={() => void pushCloudCollections()}>{collectionPublication?.running ? "모바일 컬렉션 업데이트 중…" : "모바일 컬렉션 업데이트"}</Button>
            {collectionPublication && <p role={collectionPublication.error ? "alert" : "status"}>{collectionPublication.running ? publicationProgressText(collectionPublication.progress) : collectionPublication.message}</p>}
          </dd>
        </dl>}
        <h3 className="settings-view__group-title">로컬 백업 복구</h3>
        <div className="settings-view__safety">
        {confirmingId ? (
          <div className="settings-view__safety-confirm">
            <p>현재 상태를 별도로 보존한 뒤 선택한 시점으로 관리 정보를 복구합니다.</p>
            {error && <Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast>}
            <div className="ui-dialog__actions">
              <Button disabled={pending} onClick={() => setConfirmingId(null)}>취소</Button>
              <Button variant="primary" disabled={pending} onClick={() => void restore()}>
                {pending ? "복구 중…" : "복구 시작"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {error && <div className="settings-view__safety-error"><Toast tone="error">{error}</Toast><Button onClick={() => { setError(null); setBackups(null); setBackupRetryVersion((version) => version + 1); }}>다시 시도</Button></div>}
            {!backups && !error ? (
              <Skeleton className="settings-view__skeleton" label="백업 목록을 불러오는 중" />
            ) : backups?.length === 0 ? (
              <p>사용할 수 있는 백업이 없습니다.</p>
            ) : backups ? (
              <ul className="settings-view__safety-list">
                {backups.map((backup) => (
                  <li key={backup.id} className="settings-view__safety-item">
                    <div>
                      <strong>{localDate(backup.createdAt)}</strong>
                      <span>{kindLabel(backup.kind)}</span>
                      <span>{backup.byteSize.toLocaleString("ko-KR")} B</span>
                    </div>
                    <Button disabled={pending} onClick={() => setConfirmingId(backup.id)}>이 시점으로 복구</Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        </div>
      </div>
    )}
    </div>
    </div>
  </section>;
}

function CatalogStreamSettings({ stream, busy, onUpdate }: {
  stream: CatalogStreamStatus;
  busy: boolean;
  onUpdate: (language: CatalogLanguage, maxPages: number) => Promise<void>;
}) {
  const languageLabel = catalogLanguageLabel(stream.language);
  const stateLabel = stream.initialComplete
    ? "초기 수집 완료"
    : stream.hasState
      ? "초기 수집 진행 중"
      : "초기 수집 전";
  const updateLabel = stream.initialComplete
    ? `${languageLabel} 신규 작품 갱신`
    : stream.hasState
      ? `${languageLabel} 초기 수집 계속`
      : `${languageLabel} 초기 수집 시작`;
  const maxPages = stream.language === "japanese" && !stream.initialComplete ? 1 : 40;

  return <dl className="settings-view__property">
    <dt>{languageLabel} 카탈로그</dt>
    <dd>
      <div>{stateLabel} · 대기 {stream.pendingMax.toLocaleString()}개</div>
      {stream.lastProgressAt
        ? <div className="settings-view__row-note">마지막 진행 {localDateTime(stream.lastProgressAt)} · 신규 {stream.lastAdded.toLocaleString()}개</div>
        : <div className="settings-view__row-note">아직 진행 기록이 없습니다</div>}
      {stream.lastError && <div className="settings-view__row-message" role="alert">마지막 시도 실패 — {stream.lastError}</div>}
    </dd>
    <Button size="sm" disabled={busy} onClick={() => void onUpdate(stream.language, maxPages)}>{updateLabel}</Button>
  </dl>;
}

function catalogLanguageLabel(language: CatalogLanguage): string {
  return language === "korean" ? "한국어" : "일본어";
}

const SHORTCUTS = [
  { keys: "Ctrl+1", action: "저장소 빠른 보기" },
  { keys: "Ctrl+2", action: "미분류 빠른 보기" },
  { keys: "Ctrl+3", action: "최근 빠른 보기" },
  { keys: "Ctrl+4", action: "즐겨찾기 빠른 보기" },
  { keys: "Ctrl+N", action: "새 분류 항목 추가" },
  { keys: "Ctrl+A", action: "불러온 자산 모두 선택" },
  { keys: "Ctrl+클릭", action: "한 장씩 선택 추가/제거" },
  { keys: "Shift+클릭", action: "마지막 기준점부터 범위 선택" },
  { keys: "← →", action: "같은 행의 이전·다음 자산으로 이동" },
  { keys: "↑ ↓", action: "같은 열의 위·아래 행으로 이동" },
  { keys: "Enter", action: "감상 화면 열기" },
  { keys: "F", action: "감상 화면에서 즐겨찾기 토글" },
  { keys: "Delete", action: "선택/감상 자산을 휴지통으로 이동" },
  { keys: "Escape", action: "감상 화면·선택 닫기" },
];

function kindLabel(kind: MetadataBackup["kind"]): string {
  switch (kind) {
    case "daily": return "자동 백업";
    case "pre_migration": return "업데이트 전";
    case "pre_restore": return "복구 직전";
  }
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ko-KR");
}

function localDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}
