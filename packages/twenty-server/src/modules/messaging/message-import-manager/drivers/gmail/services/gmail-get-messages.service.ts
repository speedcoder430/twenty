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

@Injectable()
export class GmailGetMessagesService {
  constructor(
    private readonly oAuth2ClientManagerService: OAuth2ClientManagerService,
    private readonly gmailMessagesImportErrorHandler: GmailMessagesImportErrorHandler,
  ) {}

  private collectScopeInputs(
    messages: MessageWithParticipants[],
    messageChannel: Pick<
      MessageChannelWorkspaceEntity,
      'messageFolders' | 'messageFolderImportPolicy'
    >,
  ): {
    messagesInDirectScope: MessageWithParticipants[];
    directScopeMessageExternalIds: Set<string>;
    threadExternalIdsToResolve: string[];
  } {
    const messagesInDirectScope = filterGmailMessagesByFolderPolicy(
      messages,
      messageChannel,
    );

    const directScopeMessageExternalIds = new Set(
      messagesInDirectScope.map((message) => message.externalId),
    );

    const threadExternalIdsToResolve = Array.from(
      new Set(
        messages
          .filter(
            (message) => !directScopeMessageExternalIds.has(message.externalId),
          )
          .map((message) => message.messageThreadExternalId),
      ),
    );

    return {
      messagesInDirectScope,
      directScopeMessageExternalIds,
      threadExternalIdsToResolve,
    };
  }

  private async resolveThreadScope(
    batchedGmailClient: gmailV1.Gmail,
    threadExternalIdsToResolve: string[],
    messageChannel: Pick<
      MessageChannelWorkspaceEntity,
      'messageFolders' | 'messageFolderImportPolicy'
    >,
  ): Promise<Map<string, boolean>> {
    const threadInScopeByExternalId = new Map<string, boolean>();

    await Promise.all(
      threadExternalIdsToResolve.map((threadExternalId) =>
        batchedGmailClient.users.threads
          .get({
            userId: 'me',
            id: threadExternalId,
            format: 'metadata',
          })
          .then((response) => {
            const threadMessages = (
              response.data as gmailV1.Schema$Thread | null
            )?.messages;

            const threadMessagesForScope = (threadMessages ?? []).map(
              (threadMessage, index) => ({
                externalId: threadMessage.id ?? `${threadExternalId}-${index}`,
                labelIds: threadMessage.labelIds,
              }),
            );

            const threadInScope =
              filterGmailMessagesByFolderPolicy(
                threadMessagesForScope as MessageWithParticipants[],
                messageChannel,
              ).length > 0;

            threadInScopeByExternalId.set(threadExternalId, threadInScope);
          })
          .catch((error) => {
            this.gmailMessagesImportErrorHandler.handleError(
              error,
              threadExternalId,
            );
            threadInScopeByExternalId.set(threadExternalId, false);
          }),
      ),
    );

    return threadInScopeByExternalId;
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
    messageChannel: Pick<
      MessageChannelWorkspaceEntity,
      'messageFolders' | 'messageFolderImportPolicy'
    >,
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

    const messagePromises = messageIds.map((messageId) =>
      batchedGmailClient.users.messages
        .get({
          userId: 'me',
          id: messageId,
        })
        .then((response) => ({ messageId, data: response.data, error: null }))
        .catch((error) => ({ messageId, data: null, error })),
    );

    const results = await Promise.all(messagePromises);

    const messages = results
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

    const {
      messagesInDirectScope,
      directScopeMessageExternalIds,
      threadExternalIdsToResolve,
    } = this.collectScopeInputs(messages, messageChannel);

    if (threadExternalIdsToResolve.length === 0) {
      return messagesInDirectScope;
    }

    const threadInScopeByExternalId = await this.resolveThreadScope(
      batchedGmailClient,
      threadExternalIdsToResolve,
      messageChannel,
    );

    return messages.filter(
      (message) =>
        directScopeMessageExternalIds.has(message.externalId) ||
        threadInScopeByExternalId.get(message.messageThreadExternalId) === true,
    );
  }
}
