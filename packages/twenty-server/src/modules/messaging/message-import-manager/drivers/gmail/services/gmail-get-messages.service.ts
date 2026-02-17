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

  private async getThreadInSyncScopeByExternalId(
    gmailClient: gmailV1.Gmail,
    threadExternalIdsToCheck: string[],
    messageChannel: MessageChannelSyncScope,
  ): Promise<Map<string, boolean>> {
    const threadInSyncScopeByExternalId = new Map<string, boolean>();

    await Promise.all(
      threadExternalIdsToCheck.map((threadExternalId) =>
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

            threadInSyncScopeByExternalId.set(
              threadExternalId,
              threadIsInSyncScope,
            );
          })
          .catch((error) => {
            this.gmailMessagesImportErrorHandler.handleError(
              error,
              threadExternalId,
            );
            threadInSyncScopeByExternalId.set(threadExternalId, false);
          }),
      ),
    );

    return threadInSyncScopeByExternalId;
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

    const threadExternalIdsToCheck = new Set<string>();

    for (const message of messages) {
      const messageIsInSyncScope = messageExternalIdsInSyncScope.has(
        message.externalId,
      );

      if (!messageIsInSyncScope) {
        threadExternalIdsToCheck.add(message.messageThreadExternalId);
      }
    }

    if (threadExternalIdsToCheck.size === 0) {
      return messagesInSyncScope;
    }

    const threadInSyncScopeByExternalId =
      await this.getThreadInSyncScopeByExternalId(
        batchedGmailClient,
        Array.from(threadExternalIdsToCheck),
        messageChannel,
      );

    const messagesToImport: MessageWithParticipants[] = [];

    for (const message of messages) {
      if (
        messageExternalIdsInSyncScope.has(message.externalId) ||
        threadInSyncScopeByExternalId.get(message.messageThreadExternalId) ===
          true
      ) {
        messagesToImport.push(message);
      }
    }

    return messagesToImport;
  }
}
