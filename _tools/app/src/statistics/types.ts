export type StatisticCount = { label: string; count: number };
export type ActivityStatistic = { id: string; label: string; count: number; lastOpenedAt: string };
export type DerivativeStorage = { measuredBytes: number; measuredFiles: number; unavailableFiles: number; scanLimitReached: boolean };
export type LibraryStatistics = {
  assets: number; collections: number; favorites: number; unclassified: number;
  originalRecordedBytes: number;
  mediaKinds: StatisticCount[]; collectedMonths: StatisticCount[];
  creators: StatisticCount[]; classifications: StatisticCount[];
  collectionAndDailyStartedAt: string;
  mostOpenedAssets: ActivityStatistic[]; mostOpenedCollections: ActivityStatistic[];
  longUnseenAssets: ActivityStatistic[];
  daily: { localDate: string; assetOpens: number; collectionOpens: number }[];
};
