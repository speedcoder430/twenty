import { Injectable } from '@nestjs/common';

import { batchFetchImplementation } from '@jrmdayn/googleapis-batcher';
import { type gmail_v1 as gmailV1, google } from 'googleapis';
import { isDefined } from 'twenty-shared/utils';

import { OAuth2ClientManagerService } from 'src/modules/connected-account/oauth2-client-manager/services/oauth2-client-manager.service';
import { type ConnectedAccountWorkspaceEntity } from 'src/modules/connected-account/standard-objects/connected-account.workspace-entity';
import { MessageChannelWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import { GmailMessagesImportErrorHandler } from 'src/modules/messaging/message-import-manager/drivers/gmail/services/gmail-messages-import-error-handler.service';
import { filterGmailMessagesByFolderPolicy } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/filter-gmail-messages-by-folder-policy.util';
import { parseAndFormatGmailMessage } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/parse-and-format-gmail-message.util';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message';

const GMAIL_BATCH_REQUEST_MAX_SIZE = 50;

type MessageChannelSyncScope = Pick<
  MessageChannelWorkspaceEntity,
  'messageFolders' | 'messageFolderImportPolicy'
>;

type MessageWithLabelIds = {
  externalId: string;
  labelIds?: string[];
};

@Injectable()
export class GmailGetMessagesService {
  constructor(
    private readonly oAuth2ClientManagerService: OAuth2ClientManagerService,
    private readonly gmailMessagesImportErrorHandler: GmailMessagesImportErrorHandler,
  ) {}

  private async getThreadExternalIdsInSyncScope(
    gmailClient: gmailV1.Gmail,
    threadExternalIds: string[],
    messageChannel: MessageChannelSyncScope,
  ): Promise<Set<string>> {
    const threadExternalIdsInSyncScope = new Set<string>();

    await Promise.all(
      threadExternalIds.map((threadExternalId) =>
        gmailClient.users.threads
          .get({
            userId: 'me',
            id: threadExternalId,
            format: 'metadata',
          })
          .then((response) => {
            const threadMessages = (
              response.data as gmailV1.Schema$Thread | null
            )?.messages;

            const threadMessagesForScopeCheck: MessageWithLabelIds[] = [];

            for (const [index, threadMessage] of (
              threadMessages ?? []
            ).entries()) {
              threadMessagesForScopeCheck.push({
                externalId: threadMessage.id ?? `${threadExternalId}-${index}`,
                labelIds: threadMessage.labelIds ?? undefined,
              });
            }

            const threadIsInSyncScope =
              filterGmailMessagesByFolderPolicy(
                threadMessagesForScopeCheck,
                messageChannel,
              ).length > 0;

            if (threadIsInSyncScope) {
              threadExternalIdsInSyncScope.add(threadExternalId);
            }
          })
          .catch((error) => {
            this.gmailMessagesImportErrorHandler.handleError(
              error,
              threadExternalId,
            );
          }),
      ),
    );

    return threadExternalIdsInSyncScope;
  }

  async getMessages(
    messageIds: string[],
    connectedAccount: Pick<
      ConnectedAccountWorkspaceEntity,
      | 'provider'
      | 'accessToken'
      | 'refreshToken'
      | 'id'
      | 'handle'
      | 'handleAliases'
    >,
    messageChannel: MessageChannelSyncScope,
  ): Promise<MessageWithParticipants[]> {
    const oAuth2Client =
      await this.oAuth2ClientManagerService.getGoogleOAuth2Client(
        connectedAccount,
      );

    const batchedFetchImplementation = batchFetchImplementation({
      maxBatchSize: GMAIL_BATCH_REQUEST_MAX_SIZE,
    });

    const batchedGmailClient = google.gmail({
      version: 'v1',
      auth: oAuth2Client,
      fetchImplementation: batchedFetchImplementation,
    });

    const messageResults = await Promise.all(
      messageIds.map((messageId) =>
        batchedGmailClient.users.messages
          .get({
            userId: 'me',
            id: messageId,
          })
          .then((response) => ({ messageId, data: response.data, error: null }))
          .catch((error) => ({ messageId, data: null, error })),
      ),
    );

    const messages = messageResults
      .map(({ messageId, data, error }) => {
        if (error) {
          this.gmailMessagesImportErrorHandler.handleError(error, messageId);

          return undefined;
        }

        return parseAndFormatGmailMessage(
          data as gmailV1.Schema$Message,
          connectedAccount,
        );
      })
      .filter(isDefined);

    const messagesInSyncScope = filterGmailMessagesByFolderPolicy(
      messages,
      messageChannel,
    );
    const messageExternalIdsInSyncScope = new Set<string>();

    for (const message of messagesInSyncScope) {
      messageExternalIdsInSyncScope.add(message.externalId);
    }

    const threadExternalIdsOutsideSyncScope = new Set<string>();

    for (const message of messages) {
      if (!messageExternalIdsInSyncScope.has(message.externalId)) {
        threadExternalIdsOutsideSyncScope.add(message.messageThreadExternalId);
      }
    }

    if (threadExternalIdsOutsideSyncScope.size === 0) {
      return messagesInSyncScope;
    }

    const threadExternalIdsInSyncScope =
      await this.getThreadExternalIdsInSyncScope(
        batchedGmailClient,
        Array.from(threadExternalIdsOutsideSyncScope),
        messageChannel,
      );

    return messages.filter(
      (message) =>
        messageExternalIdsInSyncScope.has(message.externalId) ||
        threadExternalIdsInSyncScope.has(message.messageThreadExternalId),
    );
  }
}
