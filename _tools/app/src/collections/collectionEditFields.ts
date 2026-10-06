import { KIND_LABEL } from "./collectionFormat";

/**
 * The basic-information fields of 컬렉션 편집, shared by the PC dialog and the tablet form so
 * both offer the same fields, order, wording and checks. UI-free: each surface renders them
 * with its own shared text fields.
 */
export type EditableCollectionType = "game" | "manga" | "movie" | "av";
export type CollectionEditFieldKey =
  | "developer" | "publisher" | "platforms" | "releaseDate" | "externalScore" | "originalTitle"
  | "author" | "year" | "runtimeMinutes" | "productionCompany" | "director";
/** text · date · numeric (a number typed into a text field) · minutes (a whole number of at least 1). */
export type CollectionEditControl = "text" | "date" | "numeric" | "minutes";
export type CollectionEditField = { key: CollectionEditFieldKey; label: string; control: CollectionEditControl; maxLength?: number };
/** The input attributes of each control, the same on both surfaces. */
export const COLLECTION_EDIT_INPUT: Record<CollectionEditControl, { type?: string; inputMode?: "numeric"; min?: string; step?: string }> = {
  text: {}, date: { type: "date" }, numeric: { inputMode: "numeric" }, minutes: { type: "number", min: "1", step: "1" },
};

const text = (key: CollectionEditFieldKey, label: string, maxLength = 2000): CollectionEditField => ({ key, label, control: "text", maxLength });
const RELEASE_DATE: CollectionEditField = { key: "releaseDate", label: "출시일", control: "date", maxLength: 100 };
const RUNTIME: CollectionEditField = { key: "runtimeMinutes", label: "상영 시간(분)", control: "minutes" };
const ORIGINAL_TITLE = text("originalTitle", "원제");
const PRODUCTION_COMPANY = text("productionCompany", "제작사");

export const COLLECTION_EDIT_FIELDS: Record<EditableCollectionType, readonly CollectionEditField[]> = {
  game: [text("developer", "개발사"), text("publisher", "퍼블리셔"), text("platforms", "플랫폼", 6000), RELEASE_DATE, { key: "externalScore", label: "외부 점수", control: "numeric" }],
  manga: [text("author", "작가"), { key: "year", label: "출간 연도", control: "numeric" }],
  movie: [ORIGINAL_TITLE, RUNTIME, PRODUCTION_COMPANY, text("director", "감독"), { key: "year", label: "개봉 연도", control: "numeric" }],
  av: [ORIGINAL_TITLE, PRODUCTION_COMPANY, RELEASE_DATE, RUNTIME],
};
const FIELD_BY_KEY = new Map(Object.values(COLLECTION_EDIT_FIELDS).flat().map(field => [field.key, field]));
/** Every key the dialog loads and saves, whichever type is shown. */
export const COLLECTION_EDIT_KEYS = [...FIELD_BY_KEY.keys()];
export const collectionEditField = (key: CollectionEditFieldKey) => FIELD_BY_KEY.get(key)!;
export const COLLECTION_NAME_MAX = 120;
export const COLLECTION_NAME_REQUIRED = "이름을 입력해 주세요.";

/** Types offered when creating; a series ("시리즈") is a movie work with a TV provider kind. */
export const COLLECTION_CREATE_TYPES = ["game", "manga", "movie", "tv", "av"] as const;
export type CollectionCreateType = (typeof COLLECTION_CREATE_TYPES)[number];
export const collectionCreateLabel = (type: CollectionCreateType) => type === "tv" ? "시리즈" : KIND_LABEL[type];

/** The draft text of each field, as an edit form loads it. */
export function collectionEditDraft(item?: Partial<Record<CollectionEditFieldKey, string | number | null>> | null): Record<CollectionEditFieldKey, string> {
  return Object.fromEntries(COLLECTION_EDIT_KEYS.map(key => [key, item?.[key] == null ? "" : String(item[key])])) as Record<CollectionEditFieldKey, string>;
}

/** The value a draft saves: trimmed text or null, a number or null. */
export function collectionEditValue(field: CollectionEditField, draft: string): string | number | null {
  const value = draft.trim();
  if (field.control === "numeric" || field.control === "minutes") return value ? Number(value) : null;
  return value || null;
}

/** Why a draft cannot be saved, or null. */
export function collectionEditError(field: CollectionEditField, draft: string): string | null {
  const value = collectionEditValue(field, draft);
  if (field.control === "minutes") return value !== null && (!Number.isInteger(value) || (value as number) <= 0) ? "상영 시간은 1분 이상이어야 합니다." : null;
  if (field.control === "numeric") return value !== null && (!Number.isSafeInteger(value) || (value as number) < 0) ? `${field.label} 값을 확인해 주세요.` : null;
  return field.maxLength && [...(value as string | null ?? "")].length > field.maxLength ? `${field.label}은 ${field.maxLength.toLocaleString()}자까지 쓸 수 있습니다.` : null;
}

/** Every field's saved value, including fields another type shows. */
export function collectionEditValues(draft: Record<CollectionEditFieldKey, string>): Record<CollectionEditFieldKey, string | number | null> {
  return Object.fromEntries(COLLECTION_EDIT_KEYS.map(key => [key, collectionEditValue(collectionEditField(key), draft[key])])) as Record<CollectionEditFieldKey, string | number | null>;
}
