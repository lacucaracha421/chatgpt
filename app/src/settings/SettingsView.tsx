import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { catalogStreamStatus } from "../library/catalogStreams";
import type { CatalogLanguage, CatalogStatus, CatalogStreamStatus, CloudCaptureSettings, CloudCaptureSyncResult, CloudLibraryRestoreReport, ExtensionConnection, LegacyPackageMigrationPlan, LegacyPackageMigrationReport, MetadataBackup } from "../library/types";
import { formatBytes } from "../assets/assetMetadata";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Select } from "../shared/ui/Select";
import { Toast } from "../shared/ui/Toast";
import { Toggle } from "../shared/ui/Toggle";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { CloudBackfillSettings } from "./CloudBackfillSettings";
import { CatalogVisibilitySettings } from "./CatalogVisibilitySettings";

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
};

type SettingsSection = "general" | "external_services" | "data" | "about";

const METADATA_IMPORT_FOLDER_KEY = "lakomics.metadataImportFolder";

export function SettingsView({ restoring, onRestore, onExit, onImportFolder, metadataImportRunning = false, onCollectionsChanged, onCloudCaptureSynced = () => undefined, onRestoreCloudMetadata, initialSection, privacyMode = false, onPrivacyModeChange = () => undefined }: SettingsViewProps) {
  const { error: libraryError, gateway, library, openLibrary } = useLibrary();
  const [section, setSection] = useState<SettingsSection>(() => initialSection ?? "general");
  const [lastImportFolder, setLastImportFolder] = useState(() => localStorage.getItem(METADATA_IMPORT_FOLDER_KEY));
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupRetryVersion, setBackupRetryVersion] = useState(0);
  useAutoDismiss(backups === null ? null : error, setError);
  const [submitting, setSubmitting] = useState(false);
  const [mangaRoot, setMangaRoot] = useState<string | null>(null);
  const [mangaRootError, setMangaRootError] = useState<string | null>(null);
  useAutoDismiss(mangaRootError, setMangaRootError);
  const [collectionSourceRoot, setCollectionSourceRootState] = useState<string | null>(null);
  const [collectionSourceError, setCollectionSourceError] = useState<string | null>(null);
  useAutoDismiss(collectionSourceError, setCollectionSourceError);
  const [collectionSourceMessage, setCollectionSourceMessage] = useState<string | null>(null);
  useAutoDismiss(collectionSourceMessage, setCollectionSourceMessage);
  const [extensionConnection, setExtensionConnection] = useState<ExtensionConnection | null>(null);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [switchingLibrary, setSwitchingLibrary] = useState(false);
  useAutoDismiss(extensionError, setExtensionError);
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
  useAutoDismiss(legacyError, setLegacyError);
  const [aladinConfigured, setAladinConfigured] = useState<boolean | null>(null);
  const [aladinKey, setAladinKey] = useState("");
  const [aladinBusy, setAladinBusy] = useState(false);
  const [aladinConfirmingDelete, setAladinConfirmingDelete] = useState(false);
  const [aladinError, setAladinError] = useState<string | null>(null);
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
  useAutoDismiss(aladinError, setAladinError);
  useAutoDismiss(igdbError, setIgdbError);
  useAutoDismiss(tmdbError, setTmdbError);
  useAutoDismiss(catalogError, setCatalogError);
  useAutoDismiss(catalogCacheMessage, setCatalogCacheMessage);
  useAutoDismiss(cloudError, setCloudError);
  useAutoDismiss(cloudMessage, setCloudMessage);
  const pending = restoring || submitting || aladinBusy || igdbBusy || tmdbBusy || cloudBusy;

  useEffect(() => {
    let active = true;
    void gateway.getMangaRoot().then((root) => { if (active) setMangaRoot(root); });
    void gateway.getCollectionSourceRoot().then((root) => { if (active) setCollectionSourceRootState(root); });
    return () => { active = false; };
  }, [gateway]);

  useEffect(() => {
    if (section !== "about") return;
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
    setAladinConfigured(null);
    setAladinError(null);
    setIgdbConfigured(null);
    setIgdbError(null);
    setTmdbConfigured(null);
    setTmdbError(null);
    setCloudSettings(null);
    setCloudError(null);
    void gateway.getAladinCredentialStatus().then((status) => {
      if (active) setAladinConfigured(status.configured);
    }).catch((loadError: unknown) => {
      if (active) setAladinError(commandErrorMessage(loadError, "알라딘 설정을 확인하지 못했습니다."));
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
    void gateway.getOnlineCatalogStatus().then((status) => {
      if (active) setCatalogStatus(status);
    }).catch((loadError: unknown) => {
      if (active) setCatalogError(commandErrorMessage(loadError, "온라인 카탈로그 설정을 확인하지 못했습니다."));
    });
    void gateway.getCloudCaptureSettings().then((status) => {
      if (!active) return;
      setCloudSettings(status);
      setCloudApiBaseUrl(status.apiBaseUrl ?? "");
    }).catch((loadError: unknown) => {
      if (active) setCloudError(commandErrorMessage(loadError, "Cloud Capture 설정을 확인하지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void gateway.listMetadataBackups().then((nextBackups) => {
        if (!controller.signal.aborted) { setBackups(nextBackups); setError(null); }
      }).catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(commandErrorMessage(loadError, "백업 목록을 불러오지 못했습니다."));
      });
    }, section === "data" ? 0 : 250);
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

  async function saveAladinKey() {
    if (!aladinKey.trim() || aladinBusy) return;
    setAladinBusy(true);
    setAladinError(null);
    try {
      const status = await gateway.setAladinTtbKey(aladinKey);
      setAladinConfigured(status.configured);
      setAladinKey("");
    } catch (saveError) {
      setAladinError(commandErrorMessage(saveError, "알라딘 TTB 키를 저장하지 못했습니다."));
    } finally {
      setAladinBusy(false);
    }
  }

  async function deleteAladinKey() {
    if (aladinBusy) return;
    setAladinBusy(true);
    setAladinError(null);
    try {
      const status = await gateway.deleteAladinTtbKey();
      setAladinConfigured(status.configured);
      setAladinConfirmingDelete(false);
      setAladinKey("");
    } catch (deleteError) {
      setAladinError(commandErrorMessage(deleteError, "알라딘 TTB 키를 삭제하지 못했습니다."));
    } finally {
      setAladinBusy(false);
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
    } catch (deleteError) {
      setTmdbError(commandErrorMessage(deleteError, "TMDB 토큰을 삭제하지 못했습니다."));
    } finally {
      setTmdbBusy(false);
    }
  }

  async function saveCloudSettings(enabled = cloudSettings?.enabled ?? false) {
    if (!cloudSettings || cloudBusy) return;
    const apiBaseUrl = cloudApiBaseUrl.trim() || null;
    setCloudBusy(true);
    setCloudError(null);
    setCloudMessage(null);
    try {
      const next = await gateway.setCloudCaptureSettings(enabled, apiBaseUrl);
      setCloudSettings(next);
      setCloudApiBaseUrl(next.apiBaseUrl ?? "");
      setCloudMessage("Cloud Capture 설정을 저장했습니다");
    } catch (saveError) {
      setCloudError(commandErrorMessage(saveError, "Cloud Capture 설정을 저장하지 못했습니다."));
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
      setCloudMessage("Cloud API 토큰을 저장했습니다");
    } catch (saveError) {
      setCloudError(commandErrorMessage(saveError, "Cloud API 토큰을 저장하지 못했습니다."));
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
      setCloudMessage("Cloud API 토큰을 삭제했습니다");
    } catch (deleteError) {
      setCloudError(commandErrorMessage(deleteError, "Cloud API 토큰을 삭제하지 못했습니다."));
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

  return <section className="settings-view" aria-label="설정" onKeyDown={(event) => { if (event.key === "Escape" && !pending) onExit(); }}>
    <ViewToolbar title="설정" />
    <div className="settings-view__body">
    <nav className="settings-view__navigation" aria-label="설정 구역">
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}>일반</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "external_services" ? "page" : undefined} onClick={() => setSection("external_services")}>외부 서비스</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "data" ? "page" : undefined} onClick={() => setSection("data")}>데이터 관리</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "about" ? "page" : undefined} onClick={() => setSection("about")}>정보</Button>
    </nav>
    <div className="settings-view__content">
    {section === "general" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>일반</h2><p>라이브러리 폴더와 비공개 모드를 관리합니다.</p></header>
        <dl className="settings-view__property">
          <dt>라이브러리 폴더</dt>
          <dd className="settings-view__path">{library?.root ?? "알 수 없음"}</dd>
          <Button size="sm" disabled={switchingLibrary || pending || metadataImportRunning} onClick={() => void chooseLibraryFolder()}>
            {switchingLibrary ? "여는 중…" : "다른 저장소 열기"}
          </Button>
          {libraryError && <dd className="settings-view__row-message" role="alert">{libraryError}</dd>}
        </dl>
        <dl className="settings-view__property">
          <dt>앱 버전</dt>
          <dd>{appVersion ?? "알 수 없음"}</dd>
        </dl>
        <dl className="settings-view__property">
          <dt>비공개 모드</dt>
          <dd className="settings-view__credential-status">모든 이미지와 영상을 자리표시로 가립니다. 화면 공유 중에 내용이 보이지 않습니다.</dd>
          <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}>켜기</Toggle>
        </dl>
        <dl className="settings-view__property">
          <dt>망가 폴더</dt>
          <dd className="settings-view__path">{mangaRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" onClick={() => void chooseMangaFolder()}>변경</Button>
          {mangaRootError && <dd className="settings-view__row-message" role="alert">{mangaRootError}</dd>}
        </dl>
        <dl className="settings-view__property">
          <dt>컬렉션 소스 폴더</dt>
          <dd className="settings-view__path">{collectionSourceRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" aria-label="컬렉션 소스 폴더 변경" onClick={() => void chooseCollectionSourceFolder()}>변경</Button>
          <dd className="settings-view__row-note">구버전 book 소스 위치입니다. info.txt로 컬렉션 출처를 판별할 때 사용합니다.</dd>
          {collectionSourceError && <dd className="settings-view__row-message" role="alert">{collectionSourceError}</dd>}
        </dl>
        {collectionSourceMessage && <Toast onDismiss={() => setCollectionSourceMessage(null)}>{collectionSourceMessage}</Toast>}
      </div>
    )}
    {section === "about" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>정보</h2><p>확장 프로그램 연결과 단축키를 확인합니다.</p></header>
        <h3 className="settings-view__group-title">브라우저 확장</h3>
        {extensionError && <Toast tone="error" onDismiss={() => setExtensionError(null)}>{extensionError}</Toast>}
        {!extensionConnection && !extensionError ? (
          <Skeleton className="settings-view__skeleton" label="확장 프로그램 연결 정보를 불러오는 중" />
        ) : extensionConnection ? (
          <>
            <dl className="settings-view__property">
              <dt>연결 상태</dt>
              <dd>{extensionConnection.status === "ready" ? "연결됨" : "사용 불가"}</dd>
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
        <h3 className="settings-view__group-title">단축키</h3>
        <table className="settings-view__table">
          <thead><tr><th scope="col">단축키</th><th scope="col">동작</th></tr></thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => <tr key={shortcut.keys}><td><kbd>{shortcut.keys}</kbd></td><td>{shortcut.action}</td></tr>)}
          </tbody>
        </table>
        <h3 className="settings-view__group-title">버튼 설명</h3>
        <table className="settings-view__table">
          <thead><tr><th scope="col">버튼</th><th scope="col">용도</th></tr></thead>
          <tbody>
            {BUTTONS.map((button) => <tr key={button.name}><td>{button.name}</td><td>{button.purpose}</td></tr>)}
          </tbody>
        </table>
      </div>
    )}
        {section === "external_services" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>외부 서비스</h2><p>온라인 서비스 연결과 자격 증명을 관리합니다.</p></header>
        {aladinError && <Toast tone="error" onDismiss={() => setAladinError(null)}>{aladinError}</Toast>}
        {igdbError && <Toast tone="error" onDismiss={() => setIgdbError(null)}>{igdbError}</Toast>}
        {tmdbError && <Toast tone="error" onDismiss={() => setTmdbError(null)}>{tmdbError}</Toast>}
        {catalogError && <Toast tone="error" onDismiss={() => setCatalogError(null)}>{catalogError}</Toast>}
        {cloudError && <Toast tone="error" onDismiss={() => setCloudError(null)}>{cloudError}</Toast>}
        {cloudMessage && <Toast onDismiss={() => setCloudMessage(null)}>{cloudMessage}</Toast>}
        <h3 className="settings-view__group-title">연결 상태</h3>
        <dl className="settings-view__property">
          <dt>알라딘 OpenAPI</dt>
          <dd>
            <span className="settings-view__token-row">
              <input
                className="settings-view__token"
                aria-label="알라딘 TTB 키"
                type="password"
                autoComplete="off"
                placeholder={aladinConfigured === null ? "확인 중…" : aladinConfigured ? "설정됨" : "설정되지 않음"}
                value={aladinKey}
                onChange={(event) => setAladinKey(event.target.value)}
              />
              <Button size="sm" disabled={aladinBusy || !aladinKey.trim()} onClick={() => void saveAladinKey()}>{aladinBusy ? "처리 중…" : "저장"}</Button>
            </span>
          </dd>
          {aladinConfigured && !aladinConfirmingDelete && <Button size="sm" variant="danger" disabled={aladinBusy} onClick={() => setAladinConfirmingDelete(true)}>키 삭제</Button>}
        </dl>
        {aladinConfirmingDelete && (
          <div className="settings-view__credential-confirm">
            <p>저장된 알라딘 TTB 키를 삭제할까요?</p>
            <div className="settings-view__credential-actions">
              <Button size="sm" disabled={aladinBusy} onClick={() => setAladinConfirmingDelete(false)}>취소</Button>
              <Button size="sm" variant="danger" disabled={aladinBusy} onClick={() => void deleteAladinKey()}>삭제 확인</Button>
            </div>
          </div>
        )}
        <dl className="settings-view__property">
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
                onChange={(event) => setIgdbClientId(event.target.value)}
              />
              <input
                className="settings-view__token"
                aria-label="IGDB Client Secret"
                type="password"
                autoComplete="off"
                placeholder={igdbConfigured === null ? "확인 중…" : igdbConfigured ? "설정됨" : "설정되지 않음"}
                value={igdbClientSecret}
                onChange={(event) => setIgdbClientSecret(event.target.value)}
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
        <dl className="settings-view__property">
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
                onChange={(event) => setTmdbToken(event.target.value)}
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
        <h3 className="settings-view__group-title">Cloud Capture</h3>
        {!cloudSettings ? (
          <Skeleton className="settings-view__skeleton" label="Cloud Capture 설정을 불러오는 중" />
        ) : (
          <>
            <dl className="settings-view__property">
              <dt>Cloud 수신</dt>
              <dd><Toggle checked={cloudSettings.enabled} disabled={cloudBusy || (!cloudSettings.enabled && !cloudApiBaseUrl.trim())} onChange={(event) => void saveCloudSettings(event.target.checked)}>자동 수신</Toggle></dd>
              <dd className="settings-view__row-note">앱 시작 직후와 약 5분 간격으로 VPS Capture 수신함을 확인합니다.</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>API 주소</dt>
              <dd className="settings-view__token-row">
                <input className="settings-view__token" aria-label="Cloud API 주소" type="url" autoComplete="off" placeholder="http://100.x.x.x:32146" value={cloudApiBaseUrl} onChange={(event) => setCloudApiBaseUrl(event.target.value)} />
                <Button size="sm" disabled={cloudBusy || (cloudSettings.enabled && !cloudApiBaseUrl.trim())} onClick={() => void saveCloudSettings()}>주소 저장</Button>
              </dd>
            </dl>
            <dl className="settings-view__property">
              <dt>API 토큰</dt>
              <dd className="settings-view__token-row">
                <input className="settings-view__token" aria-label="Cloud API 토큰" type="password" autoComplete="off" placeholder={cloudSettings.tokenConfigured ? "설정됨" : "설정되지 않음"} value={cloudToken} onChange={(event) => setCloudToken(event.target.value)} />
                <Button size="sm" disabled={cloudBusy || !cloudToken.trim()} onClick={() => void saveCloudToken()}>토큰 저장</Button>
                {cloudSettings.tokenConfigured && <Button size="sm" variant="danger" disabled={cloudBusy} onClick={() => void deleteCloudToken()}>토큰 삭제</Button>}
              </dd>
            </dl>
            <div className="settings-view__actions">
              <Button size="sm" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void testCloudConnection()}>연결 확인</Button>
              <Button size="sm" variant="primary" disabled={cloudBusy || !cloudSettings.enabled || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void syncCloudNow()}>지금 동기화</Button>
            </div>
            <dl className="settings-view__property">
              <dt>PC 복구 지점</dt>
              <dd className="settings-view__row-note">library.sqlite 최신 스냅샷을 서버에 저장합니다. 복원할 때 관리 에셋 원본·이미지 썸네일은 기존 Cloud Library R2 사본에서 다시 받습니다. 영상 파생물은 원본에서 재생성합니다. 외부 망가 원본 폴더 자체는 포함하지 않습니다.</dd>
              <dd className="settings-view__actions">
                <Button size="sm" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void pushCloudMetadataBackup()}>서버 복구 지점 만들기</Button>
                <Button size="sm" variant="danger" disabled={cloudBusy || !cloudSettings.apiBaseUrl || !cloudSettings.tokenConfigured} onClick={() => void restoreCloudMetadataBackup()}>서버에서 PC 복원</Button>
              </dd>
            </dl>
          </>
        )}
        <CloudBackfillSettings />
        <h3 className="settings-view__group-title">온라인 카탈로그</h3>
        {catalogStatus && <dl className="settings-view__property">
          <dt>카탈로그 상태</dt>
          <dd>{catalogStatus.installed ? `설치됨 · ${catalogStatus.workCount.toLocaleString()}개 작품` : "미설치"}</dd>
        </dl>}
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
        {catalogCacheMessage && <Toast onDismiss={() => setCatalogCacheMessage(null)}>{catalogCacheMessage}</Toast>}
      </div>
    )}
    {section === "data" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>데이터 관리</h2><p>가져오기와 백업 복구를 관리합니다.</p></header>
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
        <h3 className="settings-view__group-title">백업 복구</h3>
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

const BUTTONS = [
  { name: "즐겨찾기", purpose: "해당 자산의 즐겨찾기를 켜거나 끕니다." },
  { name: "이전/다음 자산", purpose: "감상 화면에서 이전·다음 자산을 봅니다." },
  { name: "감상 화면 닫기", purpose: "감상 화면을 닫고 갤러리로 돌아갑니다." },
  { name: "휴지통으로 이동", purpose: "감상 중인 자산을 휴지통으로 보냅니다." },
  { name: "정보", purpose: "선택 자산의 원본 정보와 분류를 보여주는 정보창을 엽니다." },
  { name: "정렬", purpose: "불러온 자산의 정렬 기준을 바꿉니다." },
  { name: "미리보기 크기", purpose: "갤러리 행의 목표 높이를 조절합니다." },
  { name: "메타데이터 표시", purpose: "타일에 출처와 수집일을 표시합니다." },
  { name: "분류 추가", purpose: "새 분류 항목 추가 대화상자를 엽니다." },
  { name: "실행 취소", purpose: "마지막 휴지통 이동을 되돌립니다." },
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
