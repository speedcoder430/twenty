import { MESSAGING_GMAIL_LABELS_WITH_CATEGORY_EXCLUSIONS } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-labels-with-category-exclusions.constant';

export const isGmailCustomLabel = (labelId: string): boolean =>
  !MESSAGING_GMAIL_LABELS_WITH_CATEGORY_EXCLUSIONS.includes(labelId);
