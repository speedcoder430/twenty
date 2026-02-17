import {
  type MessageChannelWorkspaceEntity,
  MessageFolderImportPolicy,
} from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import { MESSAGING_GMAIL_EXCLUDED_CATEGORY_LABELS } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-excluded-category-labels.constant';
import { isGmailCustomLabel } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/is-gmail-custom-label.util';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message';

export const filterGmailMessagesByFolderPolicy = (
  messages: MessageWithParticipants[],
  messageChannel: Pick<
    MessageChannelWorkspaceEntity,
    'messageFolders' | 'messageFolderImportPolicy'
  >,
): MessageWithParticipants[] => {
  const { messageFolders, messageFolderImportPolicy } = messageChannel;

  if (messageFolderImportPolicy === MessageFolderImportPolicy.ALL_FOLDERS) {
    return messages;
  }

  const syncedFolderExternalIds = (messageFolders ?? [])
    .filter((folder) => folder.isSynced && folder.externalId)
    .map((folder) => folder.externalId);

  return messages.filter((message) => {
    const messageLabelIds = message.labelIds ?? [];

    const messageIsInAtLeastOneSyncedFolder = messageLabelIds.some((labelId) =>
      syncedFolderExternalIds.includes(labelId),
    );

    if (!messageIsInAtLeastOneSyncedFolder) {
      return false;
    }

    const messageIsInSyncedCustomFolder = messageLabelIds.some(
      (labelId) =>
        syncedFolderExternalIds.includes(labelId) &&
        isGmailCustomLabel(labelId),
    );

    if (messageIsInSyncedCustomFolder) {
      return true;
    }

    const messageHasExcludedCategoryLabel = messageLabelIds.some((labelId) =>
      MESSAGING_GMAIL_EXCLUDED_CATEGORY_LABELS.includes(labelId),
    );

    return !messageHasExcludedCategoryLabel;
  });
};
