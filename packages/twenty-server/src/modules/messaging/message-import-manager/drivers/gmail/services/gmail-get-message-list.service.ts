import { Injectable, Logger } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { google, type gmail_v1 as gmailV1 } from 'googleapis';

import { OAuth2ClientManagerService } from 'src/modules/connected-account/oauth2-client-manager/services/oauth2-client-manager.service';
import { type ConnectedAccountWorkspaceEntity } from 'src/modules/connected-account/standard-objects/connected-account.workspace-entity';
import {
  MessageChannelWorkspaceEntity,
  MessageFolderImportPolicy,
} from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import { type MessageFolderWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-folder.workspace-entity';
import {
  MessageImportDriverException,
  MessageImportDriverExceptionCode,
} from 'src/modules/messaging/message-import-manager/drivers/exceptions/message-import-driver.exception';
import { MESSAGING_GMAIL_FOLDERS_WITH_CATEGORY_EXCLUSIONS } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-folders-with-category-exclusions.constant';
import { MESSAGING_GMAIL_USERS_MESSAGES_LIST_MAX_RESULT } from 'src/modules/messaging/message-import-manager/drivers/gmail/constants/messaging-gmail-users-messages-list-max-result.constant';
import { GmailGetHistoryService } from 'src/modules/messaging/message-import-manager/drivers/gmail/services/gmail-get-history.service';
import { GmailMessageListFetchErrorHandler } from 'src/modules/messaging/message-import-manager/drivers/gmail/services/gmail-message-list-fetch-error-handler.service';
import { computeGmailExcludeSearchFilter } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/compute-gmail-exclude-search-filter.util';
import { type GetMessageListsArgs } from 'src/modules/messaging/message-import-manager/types/get-message-lists-args.type';
import { type GetMessageListsResponse } from 'src/modules/messaging/message-import-manager/types/get-message-lists-response.type';

@Injectable()
export class GmailGetMessageListService {
  private readonly logger = new Logger(GmailGetMessageListService.name);
  constructor(
    private readonly gmailGetHistoryService: GmailGetHistoryService,
    private readonly oAuth2ClientManagerService: OAuth2ClientManagerService,
    private readonly gmailMessageListFetchErrorHandler: GmailMessageListFetchErrorHandler,
  ) {}

  private async getMessageExternalIdsIncludingThreadMessages({
    gmailClient,
    messageExternalIds,
    seedThreadExternalIds,
    messageFolders,
    messageFolderImportPolicy,
  }: {
    gmailClient: gmailV1.Gmail;
    messageExternalIds: string[];
    seedThreadExternalIds: string[];
    messageFolders: Pick<
      MessageFolderWorkspaceEntity,
      'name' | 'externalId' | 'isSynced' | 'parentFolderId'
    >[];
    messageFolderImportPolicy: MessageFolderImportPolicy;
  }): Promise<string[]> {
    if (
      messageFolderImportPolicy !== MessageFolderImportPolicy.SELECTED_FOLDERS
    ) {
      return messageExternalIds;
    }

    const hasSyncedCustomFolder = messageFolders.some(
      (folder) =>
        folder.isSynced &&
        isNonEmptyString(folder.externalId) &&
        !MESSAGING_GMAIL_FOLDERS_WITH_CATEGORY_EXCLUSIONS.includes(
          folder.externalId,
        ),
    );

    if (!hasSyncedCustomFolder) {
      return messageExternalIds;
    }

    const threadExternalIds = new Set(seedThreadExternalIds);

    if (threadExternalIds.size === 0) {
      return messageExternalIds;
    }

    const messageExternalIdsIncludingThreadMessages = new Set(
      messageExternalIds,
    );

    for (const threadExternalId of threadExternalIds) {
      const thread = await gmailClient.users.threads
        .get({
          userId: 'me',
          id: threadExternalId,
          format: 'metadata',
          metadataHeaders: [],
        })
        .catch((error) => {
          this.gmailMessageListFetchErrorHandler.handleError(error);

          return null;
        });

      for (const threadMessage of thread?.data?.messages ?? []) {
        if (isNonEmptyString(threadMessage.id)) {
          messageExternalIdsIncludingThreadMessages.add(threadMessage.id);
        }
      }
    }

    return Array.from(messageExternalIdsIncludingThreadMessages);
  }

  private async getMessageListWithoutCursor(
    connectedAccount: Pick<
      ConnectedAccountWorkspaceEntity,
      'provider' | 'accessToken' | 'refreshToken' | 'id' | 'handle'
    >,
    messageFolders: Pick<
      MessageFolderWorkspaceEntity,
      'name' | 'externalId' | 'isSynced' | 'parentFolderId'
    >[],
    messageChannel: Pick<
      MessageChannelWorkspaceEntity,
      'messageFolderImportPolicy'
    >,
  ): Promise<GetMessageListsResponse> {
    const oAuth2Client =
      await this.oAuth2ClientManagerService.getGoogleOAuth2Client(
        connectedAccount,
      );
    const gmailClient = google.gmail({
      version: 'v1',
      auth: oAuth2Client,
    });

    let pageToken: string | undefined;
    let hasMoreMessages = true;

    const messageExternalIds: string[] = [];
    const seedThreadExternalIds = new Set<string>();

    const excludedSearchFilter = computeGmailExcludeSearchFilter(
      messageFolders,
      messageChannel.messageFolderImportPolicy,
    );

    while (hasMoreMessages) {
      const messageList = await gmailClient.users.messages
        .list({
          userId: 'me',
          maxResults: MESSAGING_GMAIL_USERS_MESSAGES_LIST_MAX_RESULT,
          pageToken,
          q: excludedSearchFilter,
        })
        .catch((error) => {
          this.logger.error(
            `Connected account ${connectedAccount.id}: Error fetching message list: ${error.message}`,
          );
          this.logger.error(
            `Connected account ${connectedAccount.id}: Error fetching message list: ${JSON.stringify(error)}`,
          );

          this.gmailMessageListFetchErrorHandler.handleError(error);

          return {
            data: {
              messages: [],
              nextPageToken: undefined,
            },
          };
        });

      const messagesFromPage = messageList.data.messages ?? [];
      const hasMessages = messagesFromPage.length > 0;

      if (!hasMessages) {
        break;
      }

      pageToken = messageList.data.nextPageToken ?? undefined;
      hasMoreMessages = !!pageToken;

      for (const messageFromPage of messagesFromPage) {
        if (isNonEmptyString(messageFromPage.id)) {
          messageExternalIds.push(messageFromPage.id);
        }

        if (isNonEmptyString(messageFromPage.threadId)) {
          seedThreadExternalIds.add(messageFromPage.threadId);
        }
      }
    }

    if (messageExternalIds.length === 0) {
      return [
        {
          messageExternalIds,
          nextSyncCursor: '',
          previousSyncCursor: '',
          messageExternalIdsToDelete: [],
          folderId: undefined,
        },
      ];
    }

    const messageExternalIdsIncludingThreadMessages =
      await this.getMessageExternalIdsIncludingThreadMessages({
        gmailClient,
        messageExternalIds,
        seedThreadExternalIds: Array.from(seedThreadExternalIds),
        messageFolders,
        messageFolderImportPolicy: messageChannel.messageFolderImportPolicy,
      });

    const firstMessageExternalId = messageExternalIds[0];
    const firstMessageContent = await gmailClient.users.messages
      .get({
        userId: 'me',
        id: firstMessageExternalId,
      })
      .catch((error) => {
        this.gmailMessageListFetchErrorHandler.handleError(error);
      });

    const nextSyncCursor = firstMessageContent?.data?.historyId;

    if (!nextSyncCursor) {
      throw new MessageImportDriverException(
        `No historyId found for message ${firstMessageExternalId} for connected account ${connectedAccount.id}`,
        MessageImportDriverExceptionCode.NO_NEXT_SYNC_CURSOR,
      );
    }

    return [
      {
        messageExternalIds: messageExternalIdsIncludingThreadMessages,
        nextSyncCursor,
        previousSyncCursor: '',
        messageExternalIdsToDelete: [],
        folderId: undefined,
      },
    ];
  }

  public async getMessageLists({
    messageChannel,
    connectedAccount,
    messageFolders,
  }: GetMessageListsArgs): Promise<GetMessageListsResponse> {
    if (
      messageChannel.messageFolderImportPolicy ===
      MessageFolderImportPolicy.SELECTED_FOLDERS
    ) {
      const foldersToSync = messageFolders.filter((folder) => folder.isSynced);

      if (foldersToSync.length === 0) {
        this.logger.warn(
          `Connected account ${connectedAccount.id} Message Channel: ${messageChannel.id}: No folders to process`,
        );

        return [];
      }
    }

    const oAuth2Client =
      await this.oAuth2ClientManagerService.getGoogleOAuth2Client(
        connectedAccount,
      );
    const gmailClient = google.gmail({
      version: 'v1',
      auth: oAuth2Client,
    });

    if (!isNonEmptyString(messageChannel.syncCursor)) {
      return this.getMessageListWithoutCursor(
        connectedAccount,
        messageFolders,
        messageChannel,
      );
    }

    const { history, historyId: nextSyncCursor } =
      await this.gmailGetHistoryService.getHistory(
        gmailClient,
        messageChannel.syncCursor,
      );

    const { messagesAdded, messagesDeleted } =
      await this.gmailGetHistoryService.getMessageIdsFromHistory(history);

    if (!nextSyncCursor) {
      throw new MessageImportDriverException(
        `No nextSyncCursor found for connected account ${connectedAccount.id}`,
        MessageImportDriverExceptionCode.NO_NEXT_SYNC_CURSOR,
      );
    }

    return [
      {
        messageExternalIds: messagesAdded,
        messageExternalIdsToDelete: messagesDeleted,
        previousSyncCursor: messageChannel.syncCursor,
        nextSyncCursor,
        folderId: undefined,
      },
    ];
  }
}
