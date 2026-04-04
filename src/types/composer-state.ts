export interface ComposerHeaderRow {
  composerId: string;
  name: string;
  subtitle: string;
  lastUpdatedAt: string;
  lastOpenedAt: string;
  createdAt: string;
  hasUnreadMessages: boolean;
  isArchived: boolean;
  isDraft: boolean;
}

export interface ComposerHeadersPayload {
  allComposers: ComposerHeaderRow[];
}
