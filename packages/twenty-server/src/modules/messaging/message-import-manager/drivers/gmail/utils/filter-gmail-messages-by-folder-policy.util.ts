import {
  type MessageChannelWorkspaceEntity,
  MessageFolderImportPolicy,
} from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import { MESSAGING_GMAIL_EXCLUDED_CATEGORY_LABELS } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-excluded-category-labels.constant';
import { MESSAGING_GMAIL_FOLDERS_WITH_CATEGORY_EXCLUSIONS } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-folders-with-category-exclusions.constant';

type MessageWithLabelIds = {
  externalId: string;
  labelIds?: string[];
};

export const filterGmailMessagesByFolderPolicy = <
  TMessage extends MessageWithLabelIds,
>(
  messages: TMessage[],
  messageChannel: Pick<
    MessageChannelWorkspaceEntity,
    'messageFolders' | 'messageFolderImportPolicy'
  >,
): TMessage[] => {
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
        !MESSAGING_GMAIL_FOLDERS_WITH_CATEGORY_EXCLUSIONS.includes(labelId),
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
