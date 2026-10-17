/**
 * How many series (Kakao search groups) one manga collection may be connected to at once.
 * Some publishers register every volume as its own series, so the limit is generous.
 * The server (`MAX_KAKAO_GROUPS`) and the PC (`MAX_BOUND_GROUPS`) enforce the same number.
 */
export const MAX_KAKAO_GROUPS = 40;
