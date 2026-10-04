import { CloudSyncHold } from "./CloudSyncHold";
import { usePrivacy } from "../privacy/PrivacyContext";
import { displayDate, displayDateTime } from "../shared/displayDate";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { StarIcon, ComputerDesktopIcon, FolderIcon, LinkIcon, GlobeAltIcon, LockClosedIcon, WrenchIcon } from "@heroicons/react/24/outline";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Select } from "../shared/ui/Select";
import { Skeleton } from "../shared/ui/Skeleton";
import { Switch } from "../shared/ui/Switch";
import { TextInput } from "../shared/ui/TextInput";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { WorkloadControls } from "../app/WorkloadControls";
import { usePublicationJobs, publicationProgressText, startPublication, type PublicationJob } from "../library/publicationJobs";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import { latestCatalogUpdate } from "../library/catalogStreams";
import type { CatalogStatus, CloudCaptureSettings, CloudCaptureSyncResult, CloudLibraryRestoreReport, ExtensionConnection, ExtensionPairingLink, MetadataBackup } from "../library/types";
import { formatBytes } from "../assets/assetMetadata";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { confirmLeaveVaultRecovery, vaultRecoveryPending } from "../external-vault/vaultRecoveryGuard";
import { modalDialogOpen } from "../layout/modalDialog";
import { VaultSettings } from "../external-vault/VaultSettings";
import { AutoTagSettings } from "../autotags/AutoTagSettings";
import { useAutoTagInbox } from "../autotags/AutoTagInboxSettings";
import { TaggerReviewSettings } from "../autotags/TaggerReviewSettings";
import { autoTagInboxResult } from "../autotags/autoTagInbox";
import { CharacterAutomationSettings } from "./CharacterAutomationSettings";
import { CloudBackfillMaintenance, CloudBackfillSettings } from "./CloudBackfillSettings";
import { ExtensionPairingQr } from "./ExtensionPairingQr";
import { CatalogVisibilitySettings } from "./CatalogVisibilitySettings";
import { MobileCatalogPublishSettings } from "./MobileCatalogPublishSettings";
import { useReleaseCalendarRefresh } from "./ReleaseCalendarRefreshSettings";
import { useConnectionRows } from "../layout/ConnectionStatusBlock";
import { updateWorkloadSettings, useWorkloadProfile } from "../app/workloadProfile";
import { APP_ZOOM_LEVELS } from "../preferences/uiPreferences";
import { SettingsGroup, SettingsRow } from "../shared/ui/SettingsRow";

type SettingsViewProps = {
  restoring: boolean;
  onRestore: (backupId: string) => Promise<void>;
  onExit: () => void;
  onImportFolder?: (folder: string) => Promise<boolean>;
  metadataImportRunning?: boolean;
  onCollectionsChanged?: () => void;
  onCloudCaptureSynced?: (result: CloudCaptureSyncResult) => void;
  onRestoreCloudMetadata?: () => Promise<CloudLibraryRestoreReport>;
  onPrivateVaultChanged?: () => void | Promise<void>;
  initialSection?: SettingsSection;
  sectionRequest?: number;
  privacyMode?: boolean;
  onPrivacyModeChange?: (privacyMode: boolean) => void;
  appZoom?: number;
  onAppZoomChange?: (percent: number) => void;
  appZoomError?: string | null;
};

export type SettingsSection = "frequent" | "display" | "library" | "connection" | "catalog" | "vault" | "advanced";
const SECTIONS: { id: SettingsSection; label: string; Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }> }[] = [
  { id: "frequent", label: "자주 쓰는 것", Icon: StarIcon },
  { id: "display", label: "화면", Icon: ComputerDesktopIcon },
  { id: "library", label: "라이브러리", Icon: FolderIcon },
  { id: "connection", label: "연결", Icon: LinkIcon },
  { id: "catalog", label: "카탈로그", Icon: GlobeAltIcon },
  { id: "vault", label: "보관함", Icon: LockClosedIcon },
  { id: "advanced", label: "고급", Icon: WrenchIcon },
];
const METADATA_IMPORT_FOLDER_KEY = "lakomics.metadataImportFolder";
const SOURCE_LABEL = { igdb: "게임 IGDB", tmdb: "영화 TMDB", tmdb_tv: "애니 TMDB" } as const;

const SHORTCUTS = [
  ["Ctrl/Cmd + K", "찾기"], ["Ctrl/Cmd + F", "화면 안에서 찾기"], ["Esc", "메뉴·창 닫기"],
  ["Enter", "선택·적용"], ["Shift + 클릭", "반대 선택"], ["← / →", "이전·다음"],
] as const;

export function SettingsView({ restoring, onRestore, onExit, onImportFolder, metadataImportRunning = false, onCollectionsChanged, onCloudCaptureSynced = () => undefined, onRestoreCloudMetadata, onPrivateVaultChanged, initialSection, sectionRequest, privacyMode = false, onPrivacyModeChange = () => undefined, appZoom = 100, onAppZoomChange = () => undefined, appZoomError = null }: SettingsViewProps) {
  const {nsfwFilter,setNsfwFilter} = usePrivacy();
  const workspace = useWorkspaceChrome();
  const { collections: collectionPublication, characters: characterPublication } = usePublicationJobs();
  const { error: libraryError, gateway, library, openLibrary } = useLibrary();
  const [section, setSection] = useState<SettingsSection>(() => initialSection ?? "frequent");
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection, sectionRequest]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingBackup, setConfirmingBackup] = useState<string | null>(null);
  const [backupRetry, setBackupRetry] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [mangaRoot, setMangaRoot] = useState<string | null>(null);
  const [otherMachineMangaRoot, setOtherMachineMangaRoot] = useState<string | null>(null);
  const [mangaRootError, setMangaRootError] = useState<string | null>(null);
  const [switchingLibrary, setSwitchingLibrary] = useState(false);
  const [extensionConnection, setExtensionConnection] = useState<ExtensionConnection | null>(null);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [cloudSettings, setCloudSettings] = useState<CloudCaptureSettings | null>(null);
  const [cloudApiBaseUrl, setCloudApiBaseUrl] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [editingCloudToken, setEditingCloudToken] = useState(false);
  const [confirmingCloudTokenDelete, setConfirmingCloudTokenDelete] = useState(false);
  const [cloudPublisherConfigured, setCloudPublisherConfigured] = useState<boolean | null>(null);
  const [cloudPublisherToken, setCloudPublisherToken] = useState("");
  const [editingCloudPublisherToken, setEditingCloudPublisherToken] = useState(false);
  const [confirmingCloudPublisherTokenDelete, setConfirmingCloudPublisherTokenDelete] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [authorityCheck, setAuthorityCheck] = useState<import("../library/types").CollectionAuthorityVerifyResult | null>(null);
  const [authorityBusy, setAuthorityBusy] = useState(false);
  const [authorityMessage, setAuthorityMessage] = useState<string | null>(null);
  async function verifyCollectionAuthority() {
    if (!gateway.verifyCollectionAuthorityBaseline || authorityBusy) return;
    setAuthorityBusy(true);
    setAuthorityCheck(null);
    setAuthorityMessage("점검 중…");
    try {
      const result = await gateway.verifyCollectionAuthorityBaseline(progress => setAuthorityMessage(publicationProgressText(progress)));
      setAuthorityCheck(result);
      setAuthorityMessage(authorityResultText(result.report));
    } catch (cause) {
      setAuthorityMessage(`확인 불가: ${commandErrorMessage(cause, "점검을 완료하지 못했습니다.")}`);
    } finally { setAuthorityBusy(false); }
  }
  async function openAuthorityReport() {
    if (!authorityCheck || !gateway.openCollectionAuthorityReport) return;
    try { await gateway.openCollectionAuthorityReport(authorityCheck.reportPath); }
    catch (cause) { setAuthorityMessage(`확인 불가: ${commandErrorMessage(cause, "보고서를 열지 못했습니다.")}`); }
  }
  const [pairingMode, setPairingMode] = useState<"pc" | "qr">("pc");
  const [pairing, setPairing] = useState<ExtensionPairingLink | null>(null);
  const [kakaoConfigured, setKakaoConfigured] = useState<boolean | null>(null);
  const [kakaoKey, setKakaoKey] = useState("");
  const [editingKakao, setEditingKakao] = useState(false);
  const [confirmingKakaoDelete, setConfirmingKakaoDelete] = useState(false);
  const [kakaoBusy, setKakaoBusy] = useState(false);
  const [kakaoError, setKakaoError] = useState<string | null>(null);
  const [igdbConfigured, setIgdbConfigured] = useState<boolean | null>(null);
  const [igdbClientId, setIgdbClientId] = useState("");
  const [igdbClientSecret, setIgdbClientSecret] = useState("");
  const [editingIgdb, setEditingIgdb] = useState(false);
  const [confirmingIgdbDelete, setConfirmingIgdbDelete] = useState(false);
  const [igdbBusy, setIgdbBusy] = useState(false);
  const [igdbError, setIgdbError] = useState<string | null>(null);
  const [tmdbConfigured, setTmdbConfigured] = useState<boolean | null>(null);
  const [tmdbToken, setTmdbToken] = useState("");
  const [editingTmdb, setEditingTmdb] = useState(false);
  const [confirmingTmdbDelete, setConfirmingTmdbDelete] = useState(false);
  const [tmdbBusy, setTmdbBusy] = useState(false);
  const [tmdbError, setTmdbError] = useState<string | null>(null);
  const [stashdbConfigured, setStashdbConfigured] = useState<boolean | null>(null);
  const [stashdbKey, setStashdbKey] = useState("");
  const [editingStashdb, setEditingStashdb] = useState(false);
  const [confirmingStashdbDelete, setConfirmingStashdbDelete] = useState(false);
  const [stashdbBusy, setStashdbBusy] = useState(false);
  const [stashdbError, setStashdbError] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogCacheConfirming, setCatalogCacheConfirming] = useState(false);
  const [catalogCacheBusy, setCatalogCacheBusy] = useState(false);
  const [catalogCacheMessage, setCatalogCacheMessage] = useState<string | null>(null);
  const [catalogRestoreBusy, setCatalogRestoreBusy] = useState(false);
  const [catalogRestoreMessage, setCatalogRestoreMessage] = useState<string | null>(null);
  const [catalogCheckpointConfirming, setCatalogCheckpointConfirming] = useState(false);
  const [bookImportRunning, setBookImportRunning] = useState(false);
  const [bookImportMessage, setBookImportMessage] = useState<string | null>(null);
  const [lastImportFolder, setLastImportFolder] = useState(() => localStorage.getItem(METADATA_IMPORT_FOLDER_KEY));
  const cloud = useCloudSyncStatus(gateway, library?.root ?? "");
  const { health: authorityHealth } = useAuthoritySyncHealth(gateway, library?.root ?? "");
  const { calendar, busy: calendarBusy, message: calendarMessage, refreshNow: refreshCalendar } = useReleaseCalendarRefresh();
  const connectionRows = useConnectionRows({ gateway, cloud, authorityHealth });
  const inbox = useAutoTagInbox(false);
  useAutoDismiss(notice, setNotice);
  useAutoDismiss(cloudMessage, setCloudMessage);
  useAutoDismiss(catalogCacheMessage, setCatalogCacheMessage);
  useAutoDismiss(bookImportMessage, setBookImportMessage);

  const pending = restoring || submitting || switchingLibrary || cloudBusy || catalogBusy || catalogCacheBusy || catalogRestoreBusy || bookImportRunning || kakaoBusy || igdbBusy || tmdbBusy || stashdbBusy;
  const loadCloud = section === "frequent" || section === "connection" || section === "advanced";
  const loadCatalog = section === "frequent" || section === "catalog" || section === "advanced";

  useEffect(() => {
    if (!loadCloud || cloudSettings) return;
    let active = true;
    void gateway.getCloudCaptureSettings().then(next => {
      if (active) { setCloudSettings(next); setCloudApiBaseUrl(next.apiBaseUrl ?? ""); }
    }).catch(cause => { if (active) setCloudError(commandErrorMessage(cause, "서버 설정을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway, loadCloud, cloudSettings]);

  useEffect(() => {
    if (!loadCloud || !gateway.cloudPublisherTokenStatus) return;
    let active = true;
    void gateway.cloudPublisherTokenStatus().then(status => { if (active) setCloudPublisherConfigured(status.configured); }).catch(() => undefined);
    return () => { active = false; };
  }, [gateway, loadCloud]);

  useEffect(() => {
    if (section !== "frequent" && section !== "connection") return;
    let active = true;
    setExtensionConnection(null); setExtensionError(null);
    const request = gateway.getExtensionConnection?.();
    if (!request || typeof (request as Promise<ExtensionConnection | null>).then !== "function") return () => { active = false; };
    void request.then(next => { if (active) setExtensionConnection(next); })
      .catch(cause => { if (active) setExtensionError(commandErrorMessage(cause, "확장 프로그램 연결 정보를 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (section !== "connection") return;
    let active = true;
    setKakaoConfigured(null); setIgdbConfigured(null); setTmdbConfigured(null); setStashdbConfigured(null);
    void gateway.getKakaoCredentialStatus().then(next => { if (active) setKakaoConfigured(next.configured); }).catch(cause => { if (active) setKakaoError(commandErrorMessage(cause, "카카오 설정을 확인하지 못했습니다.")); });
    void gateway.getIgdbCredentialStatus().then(next => { if (active) setIgdbConfigured(next.configured); }).catch(() => { if (active) setIgdbError("IGDB 설정을 확인하지 못했습니다."); });
    void gateway.getTmdbCredentialStatus().then(next => { if (active) setTmdbConfigured(next.configured); }).catch(cause => { if (active) setTmdbError(commandErrorMessage(cause, "TMDB 설정을 확인하지 못했습니다.")); });
    void gateway.getStashdbCredentialStatus().then(next => { if (active) setStashdbConfigured(next.configured); }).catch(() => { if (active) setStashdbError("StashDB 설정을 확인하지 못했습니다."); });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    if (!loadCatalog) return;
    let active = true;
    void gateway.getOnlineCatalogStatus().then(next => { if (active) setCatalogStatus(next); })
      .catch(cause => { if (active) setCatalogError(commandErrorMessage(cause, "온라인 카탈로그 설정을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway, loadCatalog]);

  useEffect(() => {
    if (section === "advanced") void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, [section]);

  useEffect(() => {
    if (section !== "advanced") return;
    let active = true;
    const timer = window.setTimeout(() => void gateway.listMetadataBackups().then(next => { if (active) { setBackups(next); setError(null); } }).catch(cause => { if (active) setError(commandErrorMessage(cause, "백업 목록을 불러오지 못했습니다.")); }), 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [backupRetry, gateway, section]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pending || vaultRecoveryPending()) return;
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.defaultPrevented || event.isComposing || editing || modalDialogOpen()) return;
      onExit();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onExit, pending]);

  async function chooseLibraryFolder() {
    if (switchingLibrary || pending || metadataImportRunning) return;
    setSwitchingLibrary(true);
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: library?.root });
      if (typeof selected === "string") await openLibrary(selected);
    } catch (cause) { setError(commandErrorMessage(cause, "라이브러리를 열지 못했습니다.")); }
    finally { setSwitchingLibrary(false); }
  }

  async function chooseMangaFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try { await gateway.setMangaRoot(selected); setMangaRoot(selected); setOtherMachineMangaRoot(null); setNotice("망가 폴더를 저장했습니다"); }
    catch (cause) { setMangaRootError(commandErrorMessage(cause, "망가 폴더를 설정하지 못했습니다.")); }
  }

  useEffect(() => {
    if (section !== "library") return;
    let active = true;
    void gateway.getMangaRoot().then(async root => {
      if (!active) return;
      setMangaRoot(root);
      if (root === null) setOtherMachineMangaRoot(await gateway.getOtherMachineMangaRoot?.().catch(() => null) ?? null);
    }).catch(cause => { if (active) setMangaRootError(commandErrorMessage(cause, "망가 폴더를 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [gateway, section]);

  async function chooseBookImportFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string" || bookImportRunning) return;
    setBookImportRunning(true); setBookImportMessage(null);
    try {
      const report = await gateway.importBookCollections(selected);
      setBookImportMessage(`컬렉션 가져오기 완료: 스캔 ${report.scanned}개, 생성 ${report.created}개, 건너뜀 ${report.skipped}개${report.errors.length ? `, 오류 ${report.errors.length}개` : ""}`);
      if (report.created > 0) onCollectionsChanged?.();
    } catch (cause) { setBookImportMessage(commandErrorMessage(cause, "컬렉션을 가져오지 못했습니다.")); }
    finally { setBookImportRunning(false); }
  }

  async function chooseImportFolder() {
    const selected = await open({ directory: true, multiple: false, defaultPath: lastImportFolder ?? undefined });
    if (typeof selected !== "string" || !onImportFolder) return;
    if (await onImportFolder(selected)) { localStorage.setItem(METADATA_IMPORT_FOLDER_KEY, selected); setLastImportFolder(selected); }
  }

  async function restoreBackup() {
    if (!confirmingBackup || pending) return;
    setSubmitting(true); setError(null);
    try { await onRestore(confirmingBackup); setConfirmingBackup(null); setNotice("로컬 백업을 복구했습니다"); }
    catch (cause) { setError(commandErrorMessage(cause, "백업을 복구하지 못했습니다.")); }
    finally { setSubmitting(false); }
  }

  async function copyExtensionToken() {
    if (!extensionConnection?.token) return;
    try { await navigator.clipboard.writeText(extensionConnection.token); setNotice("연결 키를 복사했습니다"); }
    catch (cause) { setExtensionError(commandErrorMessage(cause, "연결 키를 복사하지 못했습니다.")); }
  }

  async function createPairing(mode: "pc" | "qr") {
    if (cloudBusy || !gateway.createExtensionPairing) return;
    setCloudBusy(true); setCloudError(null);
    try {
      const next = await gateway.createExtensionPairing();
      setPairing(next); setPairingMode(mode);
      try { if (mode === "pc") { await navigator.clipboard.writeText(next.pairingUrl); setCloudMessage("연결 링크를 복사했습니다"); } else setCloudMessage("QR을 만들었습니다"); }
      catch { setCloudMessage("연결 링크를 만들었습니다"); }
    } catch (cause) { setCloudError(commandErrorMessage(cause, "연결 링크를 만들지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function copyPairing() {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.pairingUrl); setCloudMessage("연결 링크를 복사했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "연결 링크를 복사하지 못했습니다.")); }
  }

  async function saveCloudSettings(enabled = cloudSettings?.enabled ?? false, captureEnabled = cloudSettings?.captureEnabled ?? cloudSettings?.enabled ?? false, saveAddress = false) {
    if (!cloudSettings || cloudBusy) return;
    const address = saveAddress ? cloudApiBaseUrl.trim() || null : cloudSettings.apiBaseUrl;
    if (saveAddress && address === cloudSettings.apiBaseUrl) return;
    setCloudBusy(true); setCloudError(null); setCloudMessage(null);
    try { const next = await gateway.setCloudCaptureSettings(enabled, address, captureEnabled); setCloudSettings(next); setCloudApiBaseUrl(next.apiBaseUrl ?? ""); notifyCloudBackfillSupervisor(); setCloudMessage("서버 설정을 저장했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "서버 설정을 저장하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function saveCloudToken() {
    if (!cloudToken.trim() || cloudBusy) return;
    setCloudBusy(true); setCloudError(null);
    try { const status = await gateway.setCloudApiToken(cloudToken.trim()); setCloudSettings(current => current ? { ...current, tokenConfigured: status.configured } : current); setCloudToken(""); setEditingCloudToken(false); setCloudMessage("연결 키를 저장했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "연결 키를 저장하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function deleteCloudToken() {
    if (cloudBusy) return;
    setCloudBusy(true); setCloudError(null);
    try { const status = await gateway.deleteCloudApiToken(); setCloudSettings(current => current ? { ...current, tokenConfigured: status.configured } : current); setCloudToken(""); setEditingCloudToken(false); setConfirmingCloudTokenDelete(false); setCloudMessage("연결 키를 삭제했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "연결 키를 삭제하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function saveCloudPublisherToken() {
    if (!cloudPublisherToken.trim() || cloudBusy || !gateway.setCloudPublisherToken) return;
    setCloudBusy(true); setCloudError(null);
    try { const status = await gateway.setCloudPublisherToken(cloudPublisherToken.trim()); setCloudPublisherConfigured(status.configured); setCloudPublisherToken(""); setEditingCloudPublisherToken(false); setCloudMessage("송신 키를 저장했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "송신 키를 저장하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function deleteCloudPublisherToken() {
    if (cloudBusy || !gateway.deleteCloudPublisherToken) return;
    setCloudBusy(true); setCloudError(null);
    try { const status = await gateway.deleteCloudPublisherToken(); setCloudPublisherConfigured(status.configured); setCloudPublisherToken(""); setEditingCloudPublisherToken(false); setConfirmingCloudPublisherTokenDelete(false); setCloudMessage("송신 키를 삭제했습니다"); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "송신 키를 삭제하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function testCloudConnection() {
    if (cloudBusy) return;
    setCloudBusy(true); setCloudError(null);
    try { const status = await gateway.testCloudCaptureConnection(); setCloudMessage(`연결됨 · 대기 ${status.pendingCount.toLocaleString()}건`); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "서버 연결에 실패했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function syncCloudNow() {
    if (cloudBusy) return;
    setCloudBusy(true); setCloudError(null);
    try { const result = await gateway.runDueCloudCaptureSync(); onCloudCaptureSynced(result); setCloudMessage(`동기화 완료 · 추가 ${result.added} · 검토 ${result.reviewPending} · 실패 ${result.failed}`); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "클라우드 동기화에 실패했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function pushCloudMetadataBackup() {
    if (cloudBusy || !gateway.pushCloudMetadataBackup) return;
    setCloudBusy(true); setCloudError(null);
    try { const result = await gateway.pushCloudMetadataBackup(); setCloudMessage(`서버 백업 완료 · ${formatBytes(result.byteSize)}`); }
    catch (cause) { setCloudError(commandErrorMessage(cause, "서버에 백업하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function restoreCloudMetadataBackup() {
    if (cloudBusy || (!onRestoreCloudMetadata && !gateway.restoreCloudMetadataBackup)) return;
    if (!window.confirm("서버의 최신 복구 지점으로 현재 PC 라이브러리를 복원할까요?")) return;
    setCloudBusy(true); setCloudError(null);
    try {
      const report = onRestoreCloudMetadata ? await onRestoreCloudMetadata() : await gateway.restoreCloudMetadataBackup!();
      setCloudMessage(`서버 복원 완료 · 원본 ${report.originalsRestored.toLocaleString()} · 썸네일 ${report.thumbnailsRestored.toLocaleString()} · 건너뜀 ${report.filesSkipped.toLocaleString()} · ${formatBytes(report.bytesDownloaded)}`);
      setBackupRetry(value => value + 1);
    } catch (cause) { setCloudError(commandErrorMessage(cause, "서버에서 복원하지 못했습니다.")); }
    finally { setCloudBusy(false); }
  }

  async function saveCredential(kind: "kakao" | "igdb" | "tmdb" | "stashdb") {
    if (kind === "kakao") {
      if (!kakaoKey.trim() || kakaoBusy) return; setKakaoBusy(true); setKakaoError(null);
      try { const next = await gateway.setKakaoApiKey(kakaoKey.trim()); setKakaoConfigured(next.configured); setKakaoKey(""); setEditingKakao(false); setNotice("카카오 설정을 저장했습니다"); } catch (cause) { setKakaoError(commandErrorMessage(cause, "카카오 키를 저장하지 못했습니다.")); } finally { setKakaoBusy(false); }
    } else if (kind === "igdb") {
      if (!igdbClientId.trim() || !igdbClientSecret.trim() || igdbBusy) return; setIgdbBusy(true); setIgdbError(null);
      try { const next = await gateway.setIgdbCredentials({ clientId: igdbClientId.trim(), clientSecret: igdbClientSecret.trim() }); setIgdbConfigured(next.configured); setIgdbClientId(""); setIgdbClientSecret(""); setEditingIgdb(false); setNotice("IGDB 설정을 저장했습니다"); } catch (cause) { setIgdbError(commandErrorMessage(cause, "IGDB 키를 저장하지 못했습니다.")); } finally { setIgdbBusy(false); }
    } else if (kind === "tmdb") {
      if (!tmdbToken.trim() || tmdbBusy) return; setTmdbBusy(true); setTmdbError(null);
      try { const next = await gateway.setTmdbToken(tmdbToken.trim()); setTmdbConfigured(next.configured); setTmdbToken(""); setEditingTmdb(false); setNotice("TMDB 설정을 저장했습니다"); } catch (cause) { setTmdbError(commandErrorMessage(cause, "TMDB 키를 저장하지 못했습니다.")); } finally { setTmdbBusy(false); }
    } else {
      if (!stashdbKey.trim() || stashdbBusy) return; setStashdbBusy(true); setStashdbError(null);
      try { const next = await gateway.setStashdbCredentials(stashdbKey.trim()); setStashdbConfigured(next.configured); setStashdbKey(""); setEditingStashdb(false); setNotice("StashDB 설정을 저장했습니다"); } catch (cause) { setStashdbError(commandErrorMessage(cause, "StashDB 키를 저장하지 못했습니다.")); } finally { setStashdbBusy(false); }
    }
  }

  async function deleteCredential(kind: "kakao" | "igdb" | "tmdb" | "stashdb") {
    try {
      if (kind === "kakao") { const next = await gateway.deleteKakaoApiKey(); setKakaoConfigured(next.configured); setConfirmingKakaoDelete(false); }
      if (kind === "igdb") { const next = await gateway.deleteIgdbCredentials(); setIgdbConfigured(next.configured); setConfirmingIgdbDelete(false); }
      if (kind === "tmdb") { const next = await gateway.deleteTmdbToken(); setTmdbConfigured(next.configured); setConfirmingTmdbDelete(false); }
      if (kind === "stashdb") { const next = await gateway.deleteStashdbCredentials(); setStashdbConfigured(next.configured); setConfirmingStashdbDelete(false); }
      setNotice("설정을 삭제했습니다");
    } catch (cause) {
      const message = commandErrorMessage(cause, "설정을 삭제하지 못했습니다.");
      if (kind === "kakao") setKakaoError(message); else if (kind === "igdb") setIgdbError(message); else if (kind === "tmdb") setTmdbError(message); else setStashdbError(message);
    }
  }

  async function refreshCatalog() {
    if (catalogBusy) return;
    setCatalogBusy(true); setCatalogError(null);
    try { await gateway.runDueOnlineCatalogUpdate(); setCatalogStatus(await gateway.getOnlineCatalogStatus()); setNotice("온라인 카탈로그를 갱신했습니다"); }
    catch (cause) { setCatalogError(commandErrorMessage(cause, "온라인 카탈로그를 갱신하지 못했습니다.")); }
    finally { setCatalogBusy(false); }
  }

  async function saveCatalogSettings(enabled: boolean, intervalSeconds: number) {
    if (!catalogStatus || catalogBusy) return;
    setCatalogBusy(true); setCatalogError(null);
    try { setCatalogStatus(await gateway.setOnlineCatalogUpdateSettings(enabled, intervalSeconds)); setNotice("자동 갱신 설정을 저장했습니다"); }
    catch (cause) { setCatalogError(commandErrorMessage(cause, "온라인 카탈로그 설정을 저장하지 못했습니다.")); }
    finally { setCatalogBusy(false); }
  }

  async function clearCatalogCache() {
    if (catalogCacheBusy) return;
    setCatalogCacheBusy(true); setCatalogError(null);
    try { await gateway.clearRemoteMangaCache(); setCatalogCacheConfirming(false); setCatalogCacheMessage("이미지 캐시를 지웠습니다"); }
    catch (cause) { setCatalogError(commandErrorMessage(cause, "이미지 캐시를 지우지 못했습니다.")); }
    finally { setCatalogCacheBusy(false); }
  }

  async function restoreCatalogFromVck() {
    setCatalogRestoreBusy(true); setCatalogError(null); setCatalogRestoreMessage(null);
    try { const selected = await open({ directory: true, multiple: false }); if (typeof selected !== "string") return; const next = await gateway.importVckCatalog(selected); setCatalogStatus(next); setCatalogRestoreMessage(`카탈로그를 교체했습니다 · ${next.workCount.toLocaleString()}개 작품`); }
    catch (cause) { setCatalogError(commandErrorMessage(cause, "VCK 카탈로그를 교체하지 못했습니다. 기존 카탈로그가 유지됩니다.")); }
    finally { setCatalogRestoreBusy(false); }
  }

  async function resetJapaneseCheckpoint() {
    setCatalogBusy(true); setCatalogError(null);
    try { setCatalogStatus(await gateway.resetJapaneseCatalogCheckpoint()); setCatalogCheckpointConfirming(false); setNotice("일본어 체크포인트를 재설정했습니다"); }
    catch (cause) { setCatalogError(commandErrorMessage(cause, "일본어 체크포인트를 재설정하지 못했습니다.")); }
    finally { setCatalogBusy(false); }
  }

  function openSection(next: SettingsSection) {
    if (next !== section && !confirmLeaveVaultRecovery()) return;
    setSection(next); setNotice(null);
  }

  const sectionLabel = SECTIONS.find(item => item.id === section)?.label ?? "자주 쓰는 것";
  const navigation = <nav className="settings-view__navigation" aria-label="설정 구역">
    {SECTIONS.map(({ id, label, Icon }) => <Button key={id} className="settings-view__section-button" variant="ghost" aria-current={section === id ? "page" : undefined} onClick={() => openSection(id)}><Icon className="settings-view__section-icon" aria-hidden />{label}</Button>)}
  </nav>;
  const serverRow = connectionRows.find(row => row.key === "server");
  const tabletRow = connectionRows.find(row => row.key === "tablet");
  const catalogDbUpdatedAt = catalogStatus ? latestCatalogUpdate(catalogStatus) : null;

  return <section className="settings-view" aria-label="설정">
    <ViewToolbar title={sectionLabel} titleContent={workspace ? sectionLabel : undefined} chrome={{ navigation }} />
    <div className={`settings-view__body${workspace ? " settings-view__body--integrated" : ""}`}>
      {!workspace && navigation}
      <div className="settings-view__content" key={section}>
        {notice && <Toast onDismiss={() => setNotice(null)}>{notice}</Toast>}
        {section === "frequent" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>자주 쓰는 것</h2></header>
          <SettingsGroup title="모드">
            <SimpleRow name="비공개 모드" control={<Switch aria-label="비공개 모드" checked={privacyMode} onChange={event => onPrivacyModeChange(event.target.checked)} />} />
            <SimpleRow name="NSFW 필터" status="전연령 이미지만 보여요" control={<Switch aria-label="NSFW 필터" checked={nsfwFilter} onChange={event => setNsfwFilter(event.target.checked)} />} />
            <LightweightModeRow />
          </SettingsGroup>
          <SettingsGroup title="동기화">
            <SimpleRow name="서버" status={serverRow ? joinStatus(serverRow.value, serverRow.time) : "확인 중…"} tone={serverRow?.tone} control={<Button size="sm" variant="quiet" disabled={cloudBusy || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured} onClick={() => void syncCloudNow()}>지금 받기</Button>} />
            <SimpleRow name="태블릿" status={tabletRow?.value ?? "연결된 기기 없음"} control={<Button size="sm" variant="quiet" disabled={cloudBusy} onClick={() => void createPairing("qr")}>QR 연결</Button>} />
            <SimpleRow name="브라우저 확장" status={extensionConnection ? extensionConnection.status === "ready" ? "PC 연결 준비됨" : "사용 불가" : "확인 중…"} tone={extensionConnection?.status === "ready" ? "ok" : extensionConnection ? "off" : undefined} control={<Button size="sm" variant="quiet" disabled={cloudBusy} onClick={() => void createPairing("pc")}>PC 연결</Button>} />
            {pairing && <ExtensionPairingQr value={pairing} mode={pairingMode} onCopy={copyPairing} onRefresh={() => void createPairing(pairingMode)} onClose={() => setPairing(null)} />}
          </SettingsGroup>
          <SettingsGroup title="갱신">
            <SimpleRow name="온라인 카탈로그" status={catalogStatus?.installed ? `${catalogDbUpdatedAt ? localDateTime(catalogDbUpdatedAt) : "갱신 기록 없음"} · ${intervalLabel(catalogStatus.updateIntervalSeconds)}` : "설치 안 됨"} control={catalogStatus?.installed ? <Button size="sm" variant="quiet" disabled={catalogBusy} onClick={() => void refreshCatalog()}>지금 갱신</Button> : undefined} />
            <SimpleRow name="발매 캘린더" status={calendar ? calendarStatus(calendar) : "확인 중…"} tone={calendar && calendar.sources.some(source => source.errorCode) ? "off" : "ok"} control={<Button size="sm" variant="quiet" disabled={calendarBusy} onClick={() => void refreshCalendar()}>새로 받기</Button>} />
            {inbox.settings?.folder && <SimpleRow name="자동 태그" status={autoTagInboxResult(inbox.settings)} control={<Button size="sm" variant="quiet" disabled={inbox.locked} onClick={() => void inbox.runNow()}>지금 가져오기</Button>} />}
          </SettingsGroup>
        </div>}
        {section === "display" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>화면</h2></header>
          <SettingsGroup title="화면">
            <SimpleRow name="화면 배율" control={<span className="settings-view__control-pair"><Select label="화면 배율" value={appZoom} onChange={event => onAppZoomChange(Number(event.target.value))}>{APP_ZOOM_LEVELS.map(level => <option key={level} value={level}>{level}%</option>)}</Select><Button size="sm" variant="quiet" disabled={appZoom === 100} onClick={() => onAppZoomChange(100)}>100%</Button></span>} />
            {appZoomError && <p className="settings-view__row-message" role="alert">{appZoomError}</p>}
            <SimpleRow name="비공개 모드" control={<Switch aria-label="비공개 모드" checked={privacyMode} onChange={event => onPrivacyModeChange(event.target.checked)} />} />
            <SimpleRow name="NSFW 필터" status="전연령 이미지만 보여요" control={<Switch aria-label="NSFW 필터" checked={nsfwFilter} onChange={event => setNsfwFilter(event.target.checked)} />} />
          </SettingsGroup>
          <SettingsGroup title="절약 모드">
            <WorkloadControls />
          </SettingsGroup>
        </div>}
        {section === "library" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>라이브러리</h2></header>
          <SettingsGroup title="폴더">
            <SimpleRow name="라이브러리 폴더" status={library?.root ?? "알 수 없음"} statusClassName="settings-view__path settings-view__path--left-ellipsis" control={<Button size="sm" variant="secondary" disabled={switchingLibrary || pending || metadataImportRunning} onClick={() => void chooseLibraryFolder()}>{switchingLibrary ? "여는 중…" : "다른 저장소 열기"}</Button>} />
            <SimpleRow name="망가 폴더" status={mangaRoot ?? "설정 안 됨"} control={<Button size="sm" variant="secondary" onClick={() => void chooseMangaFolder()}>변경</Button>} />
            {otherMachineMangaRoot && <p className="settings-view__status">다른 PC 경로: {otherMachineMangaRoot}</p>}
            {mangaRootError && <p className="settings-view__row-message" role="alert">{mangaRootError}</p>}
            {libraryError && <p className="settings-view__row-message" role="alert">{libraryError}</p>}
          </SettingsGroup>
          <SettingsGroup title="캐릭터" help="캐릭터 자동 분류는 새 이미지와 대기 중인 이미지를 처리합니다. 넓은 폴더 인식은 상위 폴더에 바로 저장된 이미지도 비교합니다.">
            {library ? <CharacterAutomationSettings disabled={pending} onBusyChange={() => undefined} /> : <p className="settings-view__status">라이브러리 없음</p>}
          </SettingsGroup>
          <SettingsGroup title="자동 태그" help="자동 태그 파일을 가져오면 기존 직접 태그를 건드리지 않고 자동 태그만 갱신합니다.">
            {library ? <AutoTagSettings disabled={pending} /> : <p className="settings-view__status">라이브러리 없음</p>}
          </SettingsGroup>
          <SettingsGroup title="태거 검토" help="미리보기에서 수량을 확인한 뒤 태거 판정을 적용합니다.">
            {library ? <TaggerReviewSettings disabled={pending} /> : <p className="settings-view__status">라이브러리 없음</p>}
          </SettingsGroup>
        </div>}
        {section === "connection" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>연결</h2></header>
          {(extensionError || cloudError || kakaoError || igdbError || tmdbError || stashdbError) && <Toast tone="error" onDismiss={() => { setExtensionError(null); setCloudError(null); setKakaoError(null); setIgdbError(null); setTmdbError(null); setStashdbError(null); }}>연결 설정을 처리하지 못했습니다.</Toast>}
          <SettingsGroup title="서버" help="서버 주소와 연결 키가 있어야 태블릿과 브라우저 확장이 이 PC의 자료를 받습니다. 송신 키는 이 PC가 서버에 게시할 때 씁니다.">
            <SimpleRow name="주소" control={<TextInput className="settings-view__server-address" aria-label="서버 주소" type="url" value={cloudApiBaseUrl} placeholder="http://100.x.x.x:32146" onChange={event => setCloudApiBaseUrl(event.target.value)} onBlur={() => void saveCloudSettings(undefined, undefined, true)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveCloudSettings(undefined, undefined, true); } }} />} />
            <SimpleRow name="연결 키" status={cloudSettings?.tokenConfigured ? "설정됨" : "없음"} control={<span className="settings-view__control-pair"><Badge>{cloudSettings?.tokenConfigured ? "설정됨" : "없음"}</Badge>{!editingCloudToken && <Button size="sm" variant="quiet" onClick={() => setEditingCloudToken(true)}>{cloudSettings?.tokenConfigured ? "바꾸기" : "입력"}</Button>}{cloudSettings?.tokenConfigured && !editingCloudToken && <Button size="sm" variant="quiet" className="settings-view__danger-action" onClick={() => setConfirmingCloudTokenDelete(true)}>삭제</Button>}</span>} />
            {editingCloudToken && <InlineEdit><TextInput aria-label="서버 연결 키" type="password" autoComplete="off" value={cloudToken} onChange={event => setCloudToken(event.target.value)} /><Button size="sm" variant="quiet" disabled={!cloudToken.trim() || cloudBusy} onClick={() => void saveCloudToken()}>저장</Button><Button size="sm" variant="quiet" onClick={() => { setEditingCloudToken(false); setCloudToken(""); }}>취소</Button></InlineEdit>}
            {confirmingCloudTokenDelete && <ConfirmLine text="저장된 연결 키를 삭제할까요?" onCancel={() => setConfirmingCloudTokenDelete(false)} onConfirm={() => void deleteCloudToken()} busy={cloudBusy} />}
            {gateway.setCloudPublisherToken && <>
              <SimpleRow name="송신 키" status={cloudPublisherConfigured === null ? "확인 중…" : cloudPublisherConfigured ? "설정됨" : "없음"} control={<span className="settings-view__control-pair"><Badge>{cloudPublisherConfigured === null ? "확인 중…" : cloudPublisherConfigured ? "설정됨" : "없음"}</Badge>{!editingCloudPublisherToken && <Button size="sm" variant="quiet" onClick={() => setEditingCloudPublisherToken(true)}>{cloudPublisherConfigured ? "바꾸기" : "입력"}</Button>}{cloudPublisherConfigured && !editingCloudPublisherToken && <Button size="sm" variant="quiet" className="settings-view__danger-action" onClick={() => setConfirmingCloudPublisherTokenDelete(true)}>삭제</Button>}</span>} />
              {editingCloudPublisherToken && <InlineEdit><TextInput aria-label="서버 송신 키" type="password" autoComplete="off" value={cloudPublisherToken} onChange={event => setCloudPublisherToken(event.target.value)} /><Button size="sm" variant="quiet" disabled={!cloudPublisherToken.trim() || cloudBusy} onClick={() => void saveCloudPublisherToken()}>저장</Button><Button size="sm" variant="quiet" onClick={() => { setEditingCloudPublisherToken(false); setCloudPublisherToken(""); }}>취소</Button></InlineEdit>}
              {confirmingCloudPublisherTokenDelete && <ConfirmLine text="저장된 송신 키를 삭제할까요?" onCancel={() => setConfirmingCloudPublisherTokenDelete(false)} onConfirm={() => void deleteCloudPublisherToken()} busy={cloudBusy} />}
            </>}
            <SimpleRow name="연결 상태" status={serverRow ? joinStatus(serverRow.value, serverRow.time) : "확인 중…"} tone={serverRow?.tone} control={<Button size="sm" variant="secondary" disabled={cloudBusy || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured} onClick={() => void testCloudConnection()}>연결 확인</Button>} />
            {cloudSettings?.apiBaseUrl && gateway.getCloudSyncHold && gateway.setCloudSyncHold && <CloudSyncHold endpoint={cloudSettings.apiBaseUrl} read={gateway.getCloudSyncHold} save={gateway.setCloudSyncHold} />}
            <SimpleRow name="클라우드에서 받기" control={<Switch aria-label="클라우드에서 받기" checked={cloudSettings?.captureEnabled ?? cloudSettings?.enabled ?? false} disabled={cloudBusy || !cloudSettings?.apiBaseUrl} onChange={event => void saveCloudSettings(cloudSettings?.enabled, event.target.checked)} />} />
            <SimpleRow name="클라우드로 복제" control={<Switch aria-label="클라우드로 복제" checked={cloudSettings?.enabled ?? false} disabled={cloudBusy || !cloudSettings?.apiBaseUrl} onChange={event => void saveCloudSettings(event.target.checked, cloudSettings?.captureEnabled ?? cloudSettings?.enabled)} />} />
            <SimpleRow name="컬렉션 서버 이전 점검" status={authorityMessage ?? "이전할 때 빠지는 자료가 있는지 확인합니다"} control={<span className="settings-view__control-pair"><Button size="sm" variant="quiet" disabled={authorityBusy || cloudBusy || collectionPublication?.running || !cloudSettings?.enabled || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured || !cloudPublisherConfigured || !gateway.verifyCollectionAuthorityBaseline} onClick={() => void verifyCollectionAuthority()}>{authorityBusy ? "점검 중…" : "점검하기"}</Button>{authorityCheck && gateway.openCollectionAuthorityReport && <Button size="sm" variant="quiet" onClick={() => void openAuthorityReport()}>보고서 열기</Button>}</span>} />
          </SettingsGroup>
          <SettingsGroup title="동기화 상태">
            <CloudBackfillSettings embedded connectionReady={cloudSettings ? Boolean(cloudSettings.apiBaseUrl && cloudSettings.tokenConfigured) : null}>
              {cloudMessage && <p className="settings-view__confirmation" role="status">{cloudMessage}</p>}
            </CloudBackfillSettings>
          </SettingsGroup>
          <SettingsGroup title="기기">
            <SimpleRow name="태블릿" status={tabletRow?.value ?? "연결된 기기 없음"} control={<Button size="sm" variant="secondary" onClick={() => void createPairing("qr")}>QR 연결</Button>} />
            <SimpleRow name="브라우저 확장" status={extensionConnection?.baseUrl ?? "확인 중…"} control={<span className="settings-view__control-pair"><Button size="sm" variant="quiet" disabled={!extensionConnection?.token} onClick={() => void copyExtensionToken()}>키 복사</Button><Button size="sm" variant="secondary" onClick={() => void createPairing("pc")}>PC 연결</Button></span>} />
            {pairing && <ExtensionPairingQr value={pairing} mode={pairingMode} onCopy={copyPairing} onRefresh={() => void createPairing(pairingMode)} onClose={() => setPairing(null)} />}
          </SettingsGroup>
          <SettingsGroup title="작품 정보 서비스">
            <CredentialRow name="카카오 책 검색" configured={kakaoConfigured} editing={editingKakao} value={kakaoKey} busy={kakaoBusy} onEdit={() => setEditingKakao(true)} onChange={setKakaoKey} onSave={() => void saveCredential("kakao")} onCancel={() => { setEditingKakao(false); setKakaoKey(""); }} confirmDelete={confirmingKakaoDelete} onDelete={() => setConfirmingKakaoDelete(true)} onCancelDelete={() => setConfirmingKakaoDelete(false)} onConfirmDelete={() => void deleteCredential("kakao")} />
            <CredentialRow name="IGDB" configured={igdbConfigured} editing={editingIgdb} value={igdbClientId} secondValue={igdbClientSecret} busy={igdbBusy} onEdit={() => setEditingIgdb(true)} onChange={setIgdbClientId} onSecondChange={setIgdbClientSecret} onSave={() => void saveCredential("igdb")} onCancel={() => { setEditingIgdb(false); setIgdbClientId(""); setIgdbClientSecret(""); }} confirmDelete={confirmingIgdbDelete} onDelete={() => setConfirmingIgdbDelete(true)} onCancelDelete={() => setConfirmingIgdbDelete(false)} onConfirmDelete={() => void deleteCredential("igdb")} />
            <CredentialRow name="TMDB" configured={tmdbConfigured} editing={editingTmdb} value={tmdbToken} busy={tmdbBusy} onEdit={() => setEditingTmdb(true)} onChange={setTmdbToken} onSave={() => void saveCredential("tmdb")} onCancel={() => { setEditingTmdb(false); setTmdbToken(""); }} confirmDelete={confirmingTmdbDelete} onDelete={() => setConfirmingTmdbDelete(true)} onCancelDelete={() => setConfirmingTmdbDelete(false)} onConfirmDelete={() => void deleteCredential("tmdb")} />
            <CredentialRow name="StashDB" configured={stashdbConfigured} editing={editingStashdb} value={stashdbKey} busy={stashdbBusy} onEdit={() => setEditingStashdb(true)} onChange={setStashdbKey} onSave={() => void saveCredential("stashdb")} onCancel={() => { setEditingStashdb(false); setStashdbKey(""); }} confirmDelete={confirmingStashdbDelete} onDelete={() => setConfirmingStashdbDelete(true)} onCancelDelete={() => setConfirmingStashdbDelete(false)} onConfirmDelete={() => void deleteCredential("stashdb")} />
          </SettingsGroup>
          <SettingsGroup title="발매 캘린더">
            {calendar?.sources.map(source => <SimpleRow key={source.provider} name={SOURCE_LABEL[source.provider]} status={source.errorCode ? "가져오기 실패" : source.fetchedAt ? localDateTime(source.fetchedAt) : "받은 기록 없음"} tone={source.errorCode ? "off" : "ok"} />)}
            <div className="settings-view__group-action"><Button size="sm" variant="quiet" disabled={calendarBusy} onClick={() => void refreshCalendar()}>새로 받기</Button>{calendarMessage && <span className="settings-view__status">{calendarMessage}</span>}</div>
            <p className="settings-view__status">TMDB 제공: <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">TMDB</a></p>
          </SettingsGroup>
        </div>}
        {section === "catalog" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>카탈로그</h2></header>
          {catalogError && <Toast tone="error" onDismiss={() => setCatalogError(null)}>{catalogError}</Toast>}
          <SettingsGroup title="온라인 카탈로그">
            <SimpleRow name="상태" value={catalogStatus ? catalogStatus.installed ? `설치됨 · ${catalogStatus.workCount.toLocaleString()}개 작품` : "설치 안 됨" : "확인 중…"} status={catalogStatus?.lastSuccessAt ? `최근 갱신 ${localDateTime(catalogStatus.lastSuccessAt)}` : "최근 갱신 기록 없음"} />
            <SimpleRow name="자동 갱신" control={<Switch aria-label="자동 갱신" checked={catalogStatus?.updateEnabled ?? false} disabled={catalogBusy || !catalogStatus?.installed} onChange={event => void saveCatalogSettings(event.target.checked, catalogStatus?.updateIntervalSeconds ?? 3600)} />} />
            <SimpleRow name="갱신 간격" control={<SegmentedControl label="갱신 간격" value={String(catalogStatus?.updateIntervalSeconds ?? 3600)} options={[{ value: "3600", label: "1시간" }, { value: "21600", label: "6시간" }, { value: "86400", label: "24시간" }]} onChange={value => { if (catalogStatus?.updateEnabled) void saveCatalogSettings(true, Number(value)); }} className={!catalogStatus?.updateEnabled ? "settings-view__control-disabled" : undefined} />} />
          </SettingsGroup>
          <SettingsGroup title="검색 결과 숨김"><CatalogVisibilitySettings /></SettingsGroup>
          <SettingsGroup title="이미지 캐시">
            <SimpleRow name="이미지 캐시" control={!catalogCacheConfirming ? <Button size="sm" variant="secondary" disabled={catalogCacheBusy} onClick={() => setCatalogCacheConfirming(true)}>캐시 지우기</Button> : <span className="settings-view__control-pair"><Button size="sm" variant="quiet" onClick={() => setCatalogCacheConfirming(false)}>취소</Button><Button size="sm" variant="danger" disabled={catalogCacheBusy} onClick={() => void clearCatalogCache()}>삭제 확인</Button></span>} />
            {catalogCacheMessage && <p className="settings-view__status">{catalogCacheMessage}</p>}
          </SettingsGroup>
        </div>}
        {section === "vault" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>보관함</h2></header>
          <SettingsGroup title="비밀 보관함" help="복구키는 비밀번호를 잊었을 때 보관함을 여는 유일한 방법입니다. 보관함을 만들 때 한 번만 표시됩니다.">
            <VaultSettings onChanged={onPrivateVaultChanged} onSaved={setNotice} />
          </SettingsGroup>
        </div>}
        {section === "advanced" && <div className="settings-view__section">
          <header className="settings-view__header"><h2>고급</h2></header>
          <SettingsGroup title="동기화 점검·복구">
            <CloudBackfillMaintenance />
          </SettingsGroup>
          <SettingsGroup title="서버 백업·복원" help="서버 백업은 라이브러리 관리 정보와 서버에 보관된 복구 자료를 대상으로 합니다.">
            <SimpleRow name="서버 복구 지점" control={<span className="settings-view__control-pair"><Button size="sm" variant="secondary" disabled={cloudBusy || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured} onClick={() => void pushCloudMetadataBackup()}>백업 만들기</Button><Button size="sm" variant="danger" disabled={cloudBusy || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured} onClick={() => void restoreCloudMetadataBackup()}>서버에서 복원</Button></span>} />
            {cloudError && <p className="settings-view__row-message" role="alert">{cloudError}</p>}
          </SettingsGroup>
          <SettingsGroup title="로컬 백업 복구">
            {confirmingBackup ? <ConfirmLine text="현재 상태를 보존한 뒤 선택한 시점으로 복구합니다." onCancel={() => setConfirmingBackup(null)} onConfirm={() => void restoreBackup()} busy={pending} confirmLabel="복구 시작" /> : error ? <div className="settings-view__control-pair"><Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast><Button size="sm" onClick={() => { setBackups(null); setBackupRetry(value => value + 1); }}>다시 시도</Button></div> : !backups ? <Skeleton className="settings-view__skeleton" label="백업 목록을 불러오는 중" /> : backups.length === 0 ? <p className="settings-view__status">사용할 수 있는 백업이 없습니다.</p> : <ul className="settings-view__safety-list">{backups.map(backup => <li key={backup.id} className="settings-view__safety-item"><span><strong>{localDate(backup.createdAt)}</strong><small>{kindLabel(backup.kind)} · {backup.byteSize.toLocaleString("ko-KR")} B</small></span><Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirmingBackup(backup.id)}>이 시점으로 복구</Button></li>)}</ul>}
          </SettingsGroup>
          <SettingsGroup title="모바일 게시">
            <MobilePublishRow name="모바일 컬렉션" job={collectionPublication} action={collectionPublication?.running ? "업데이트 중…" : "모바일 컬렉션 업데이트"} disabled={cloudBusy || collectionPublication?.running || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured || !gateway.pushCloudCollections} onClick={() => void startPublication("collections", progress => gateway.pushCloudCollections!(progress), result => `${result.collections.toLocaleString()}개 완료 · 이미지 업로드 ${result.uploaded.toLocaleString()}개`)} />
            <MobilePublishRow name="모바일 캐릭터" job={characterPublication} action={characterPublication?.running ? "업데이트 중…" : "모바일 캐릭터 업데이트"} disabled={cloudBusy || characterPublication?.running || !cloudSettings?.apiBaseUrl || !cloudSettings?.tokenConfigured || !gateway.pushCloudCharacters} onClick={() => void startPublication("characters", progress => gateway.pushCloudCharacters!(progress), result => `${result.nodes.toLocaleString()}개 보기 게시 완료`)} />
            <MobileCatalogPublishSettings />
          </SettingsGroup>
          <SettingsGroup title="가져오기">
            <SimpleRow name="컬렉션 가져오기 · book 폴더" status={bookImportMessage ?? undefined} control={<Button size="sm" variant="secondary" disabled={bookImportRunning} onClick={() => void chooseBookImportFolder()}>{bookImportRunning ? "가져오는 중…" : "폴더 선택"}</Button>} />
            <SimpleRow name="메타데이터 가져오기" status={lastImportFolder ?? "설정 안 됨"} control={<span className="settings-view__control-pair">{lastImportFolder && <Button size="sm" variant="quiet" disabled={metadataImportRunning || !onImportFolder} onClick={() => void onImportFolder?.(lastImportFolder)}>최근 폴더 다시 가져오기</Button>}<Button size="sm" variant="secondary" disabled={metadataImportRunning || !onImportFolder} onClick={() => void chooseImportFolder()}>다른 폴더 선택</Button></span>} />
          </SettingsGroup>
          <SettingsGroup title="카탈로그 복구">
            <SimpleRow name="일본어 체크포인트" control={!catalogCheckpointConfirming ? <Button size="sm" variant="secondary" disabled={catalogBusy || !catalogStatus?.installed} onClick={() => setCatalogCheckpointConfirming(true)}>재설정</Button> : <span className="settings-view__control-pair"><Button size="sm" variant="quiet" onClick={() => setCatalogCheckpointConfirming(false)}>취소</Button><Button size="sm" variant="danger" disabled={catalogBusy} onClick={() => void resetJapaneseCheckpoint()}>재설정 확인</Button></span>} />
            <SimpleRow name="VCK 폴더" status={catalogRestoreMessage ?? undefined} control={<Button size="sm" variant="secondary" disabled={catalogRestoreBusy} onClick={() => void restoreCatalogFromVck()}>{catalogRestoreBusy ? "교체 중…" : "다시 선택"}</Button>} />
          </SettingsGroup>
          <SettingsGroup title="정보">
            <SimpleRow name="앱 버전" status={appVersion ?? "알 수 없음"} />
            <table className="settings-view__table"><thead><tr><th scope="col">단축키</th><th scope="col">동작</th></tr></thead><tbody>{SHORTCUTS.map(([keys, action]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}</tbody></table>
          </SettingsGroup>
        </div>}
      </div>
    </div>
  </section>;
}

const SimpleRow = SettingsRow;

function authorityResultText(report: import("../library/types").CollectionAuthorityVerifyReport): string {
  if (report.verdict === "lossless") return "잃는 항목 없음";
  if (report.verdict === "blocked") {
    const reasons: Record<string, string> = { legacyRevision: "게시된 자료가 변경됐습니다", personalEdits: "개인 편집을 아직 모두 받지 못했습니다", bindRequests: "연결 요청을 아직 모두 받지 못했습니다", releaseReads: "신간 읽음 상태를 아직 모두 받지 못했습니다", releaseGeneration: "신간 게시 상태가 변경됐습니다" };
    const failed = Object.keys(report.bindings).find(key => report.bindings[key]?.ok === false);
    return `확인 불가: ${report.validation?.message ?? (failed ? reasons[failed] : null) ?? "보고서를 확인해 주세요"}`;
  }
  const count = report.diffs.total + report.people.diffs + report.works.missing.length + report.works.unknown.length + report.works.typeMismatch.length + report.artworks.originalMissing + report.artworks.unconfirmedBlobs;
  // Work-id lists are capped at 20 by the report contract. Do not present the
  // sampled total as an exact count when any list may have been truncated.
  const sampled = [report.works.missing, report.works.unknown, report.works.typeMismatch].some(ids => ids.length >= 20);
  return `차이 ${count.toLocaleString()}건${sampled ? " 이상" : ""}`;
}

function InlineEdit({ children }: { children: ReactNode }) { return <div className="settings-view__inline-edit">{children}</div>; }

function ConfirmLine({ text, onCancel, onConfirm, busy, confirmLabel = "확인" }: { text: string; onCancel: () => void; onConfirm: () => void; busy: boolean; confirmLabel?: string }) {
  return <div className="settings-view__confirm-line"><span>{text}</span><span className="settings-view__control-pair"><Button size="sm" variant="quiet" disabled={busy} onClick={onCancel}>취소</Button><Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button></span></div>;
}

function CredentialRow({ name, configured, editing, value, secondValue, busy, onEdit, onChange, onSecondChange, onSave, onCancel, confirmDelete, onDelete, onCancelDelete, onConfirmDelete }: { name: string; configured: boolean | null; editing: boolean; value: string; secondValue?: string; busy: boolean; onEdit: () => void; onChange: (value: string) => void; onSecondChange?: (value: string) => void; onSave: () => void; onCancel: () => void; confirmDelete: boolean; onDelete: () => void; onCancelDelete: () => void; onConfirmDelete: () => void }) {
  return <>
    <SimpleRow name={name} control={!editing ? <span className="settings-view__control-pair"><Badge>{configured ? "설정됨" : "없음"}</Badge><Button size="sm" variant="quiet" aria-label={`${name} ${configured ? "바꾸기" : "입력"}`} onClick={onEdit}>{configured ? "바꾸기" : "입력"}</Button>{configured && <Button size="sm" variant="quiet" aria-label={`${name} 삭제`} className="settings-view__danger-action" onClick={onDelete}>삭제</Button>}</span> : undefined} />
    {editing && <InlineEdit><TextInput aria-label={`${name} 입력`} type="password" autoComplete="off" value={value} onChange={event => onChange(event.target.value)} />{secondValue !== undefined && onSecondChange && <TextInput aria-label={`${name} Secret`} type="password" autoComplete="off" value={secondValue} onChange={event => onSecondChange(event.target.value)} />}<Button size="sm" variant="quiet" disabled={busy || !value.trim() || (secondValue !== undefined && !secondValue.trim())} onClick={onSave}>저장</Button><Button size="sm" variant="quiet" onClick={onCancel}>취소</Button></InlineEdit>}
    {confirmDelete && <ConfirmLine text={`${name} 설정을 삭제할까요?`} onCancel={onCancelDelete} onConfirm={onConfirmDelete} busy={busy} confirmLabel="삭제 확인" />}
  </>;
}

function MobilePublishRow({ name, job, action, disabled, onClick }: { name: string; job: PublicationJob | null | undefined; action: string; disabled: boolean; onClick: () => void }) {
  return <SimpleRow name={name} status={job ? job.running ? publicationProgressText(job.progress) : job.message ?? undefined : undefined} tone={job?.error ? "off" : undefined} control={<Button size="sm" variant="secondary" disabled={disabled} onClick={onClick}>{action}</Button>} />;
}

function LightweightModeRow() {
  const profile = useWorkloadProfile();
  const [busy, setBusy] = useState(false);
  const control = !profile.ready ? <Switch aria-label="절약 모드" checked={profile.lightweight} disabled /> : <Switch aria-label="절약 모드" checked={profile.lightweight} disabled={busy} onChange={() => {
    setBusy(true);
    void updateWorkloadSettings({ lightweight: !profile.lightweight }).finally(() => setBusy(false));
  }} />;
  const status = profile.ready ? `${profile.lightweight ? "절약 모드" : profile.restricted ? "절약 모드 해제 중" : "일반 모드"}${profile.autoEnterMinutes === null ? " · 자동 전환 꺼짐" : ` · ${profile.autoEnterMinutes}분 쉬면 자동으로 켜짐`}` : "확인 중…";
  return <SimpleRow name="절약 모드" status={status} control={control} />;
}

function joinStatus(value: string, time?: string) { return time ? `${value} · ${time}` : value; }
function intervalLabel(seconds: number) { return seconds === 3600 ? "1시간마다" : seconds === 21600 ? "6시간마다" : "24시간마다"; }
function calendarStatus(calendar: { sources: { provider: keyof typeof SOURCE_LABEL; fetchedAt: string | null; errorCode?: string | null }[] }) {
  const fetched = calendar.sources.map(source => source.fetchedAt).filter((value): value is string => Boolean(value)).sort().reverse()[0];
  const sources = calendar.sources.map(source => SOURCE_LABEL[source.provider]).join(" · ");
  return `${fetched ? localDateTime(fetched) : "받은 기록 없음"}${sources ? ` · ${sources}` : ""}${calendar.sources.some(source => source.errorCode) ? " · 일부 실패" : ""}`;
}
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : displayDate(value); }
function localDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : displayDateTime(value, new Date(), { withTime: true }); }
function kindLabel(kind: MetadataBackup["kind"]) { return kind === "pre_restore" ? "복구 전 보존" : kind === "pre_migration" ? "이전 전 보존" : "자동"; }
