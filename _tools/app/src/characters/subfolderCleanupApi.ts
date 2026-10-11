import { invoke } from "@tauri-apps/api/core";

/**
 * "하위 폴더를 그룹으로 정리": the direct sub-folders of a registered series become groups.
 * `plan` is read-only; `apply` runs everything in one transaction (all or nothing).
 */

/** `group`: the folder becomes a group. `lift`: a one-character nested series; its images move up and its
 * character joins the series without a group. `keep`: the folder stays exactly as it is. */
export type CleanupAction = "group" | "lift" | "keep";

export type CleanupCharacterRef = { targetId: string; name: string };

export type CleanupNestedSeries = {
  seriesId: string;
  name: string;
  /** 1 for a direct sub-folder that is a series, deeper for a series inside a folder. */
  depth: number;
  characters: CleanupCharacterRef[];
  groupCount: number;
};

export type CleanupFolder = {
  folderId: string;
  name: string;
  /** Normal images in the folder and everything below it. */
  imageCount: number;
  /** Of those, images no character of the series (or of a nested series that moves in) holds. */
  imagesWithoutCharacter: number;
  /** Folders that disappear with it (itself and every folder below it). */
  folderCount: number;
  isSeries: boolean;
  nestedSeries: CleanupNestedSeries[];
  proposedAction: CleanupAction;
  /** Korean reason when `keep` is proposed (excluded or protected folder). */
  keepReason: string | null;
  /** The group's name unless another is given. */
  defaultGroupName: string;
};

export type CleanupCharacter = {
  targetId: string;
  name: string;
  /** The series the character lives in now. */
  seriesId: string;
  /** The direct sub-folder whose nested series holds the character. */
  fromFolderId: string | null;
  currentGroupId: string | null;
  currentGroupName: string | null;
  imageCount: number;
  /** Images per direct sub-folder (folders with none are left out). */
  folderCounts: { folderId: string; count: number }[];
  /** Images directly in the series folder. */
  directCount: number;
  /** The folder whose group the character joins by the rule; null = no group (or it keeps its current group). */
  proposedGroupFolderId: string | null;
  /** Folders with the same top count: no default, a choice is required (null = no group is a valid choice). */
  tie: string[] | null;
  /** The proposal rests on a single image. */
  weak: boolean;
};

export type CleanupPlan = {
  seriesId: string;
  seriesName: string;
  /** Send back unchanged with `apply`; it refuses when folders, images, characters or groups changed. */
  fingerprint: string;
  folders: CleanupFolder[];
  characters: CleanupCharacter[];
  /** Nested series that will be unregistered, deepest first. */
  seriesToUnregister: { seriesId: string; name: string; folderId: string }[];
  /** Characters that change series (they move into the series). */
  movingCharacters: CleanupCharacterRef[];
  /** Folders removed once their images are lifted. */
  foldersToRemove: { folderId: string; name: string }[];
  /** Normal images that move into the series folder. */
  imagesToLift: number;
  /** Images directly in the series folder now; they stay. */
  directImageCount: number;
  /** Names that already exist (Korean, ready to show); apply refuses while any is left. */
  collisions: string[];
};

export type CleanupFolderChoice = {
  folderId: string;
  action: CleanupAction;
  /** Only for `group`; defaults to the folder's name. */
  groupName?: string | null;
};

export type CleanupCharacterChoice = {
  targetId: string;
  /** The folder whose group the character joins; null = in no group. */
  groupFolderId: string | null;
};

export type CleanupRequest = {
  seriesId: string;
  expectedPlanFingerprint: string;
  /** A sub-folder that is not listed is kept as it is. */
  folders: CleanupFolderChoice[];
  /** A character without an entry takes the plan's proposal; a `tie` character must have an entry. */
  characterGroups: CleanupCharacterChoice[];
};

export type CleanupResult = {
  seriesId: string;
  /** False when the choices left nothing to do (nothing was written). */
  changed: boolean;
  /** True when the folders to clean were already gone (the same run was committed earlier). */
  alreadyApplied: boolean;
  groupsCreated: { folderId: string; groupId: string; name: string; memberCount: number; extrasCount: number }[];
  /** Folders chosen as groups that had neither a member nor a 기타 image. */
  groupsSkipped: { folderId: string; name: string }[];
  charactersGrouped: number;
  seriesUnregistered: { folderId: string; name: string }[];
  charactersMoved: number;
  imagesLifted: number;
  foldersRemoved: { folderId: string; name: string }[];
  /** Folders that could not be removed because something still sits in them. */
  foldersKept: { folderId: string; name: string; reason: string }[];
  /** Images put into the series' own 기타 (from `lift` folders). */
  seriesExtrasCount: number;
};

export const subfolderCleanupApi = {
  plan: (seriesId: string): Promise<CleanupPlan> => invoke("character_subfolder_cleanup_plan", { seriesId }),
  apply: (request: CleanupRequest): Promise<CleanupResult> => invoke("apply_character_subfolder_cleanup", { request }),
};
