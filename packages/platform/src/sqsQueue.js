/**
 * Amazon SQS job queue, with the same lease contract as MemoryQueue.
 *
 * Retry and dead-lettering are SQS's own: a message that is received but not
 * deleted reappears after its visibility timeout, and the queue's redrive
 * policy moves it to the dead-letter queue after `maxReceiveCount` receives.
 * The worker only has to delete on success and give up on failure.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

export class SqsQueue {
  /**
   * @param {{region: string, queueUrl: string, dlqUrl?: string}} options - Queue location
   */
  constructor({ region, queueUrl, dlqUrl }) {
    if (!queueUrl) throw new Error("QUEUE_URL is required when PLATFORM=aws");
    this.client = new SQSClient({ region });
    this.queueUrl = queueUrl;
    this.dlqUrl = dlqUrl;
  }

  /**
   * @param {Object} job - Job body
   * @returns {Promise<void>}
   */
  async send(job) {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }),
    );
  }

  /**
   * Long-poll for one job.
   * @param {{waitMs?: number}} options - Wait budget (SQS caps it at 20 s)
   * @returns {Promise<Object|null>} A lease, or null if nothing arrived
   */
  async receive({ waitMs = 20000 } = {}) {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: Math.min(20, Math.max(0, Math.round(waitMs / 1000))),
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const message = result.Messages?.[0];
    if (!message) return null;

    const handle = message.ReceiptHandle;
    const makeVisible = () =>
      this.client
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: handle,
            VisibilityTimeout: 0,
          }),
        )
        .catch(() => {
          // If this fails the message still reappears when its timeout lapses.
        });

    return {
      job: JSON.parse(message.Body),
      attempts: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      ack: () =>
        this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: handle })),
      // Make it visible now rather than after the timeout. The receive count has
      // already gone up, so the redrive policy still bounds how often this repeats.
      retry: makeVisible,
      // SQS cannot return a message without counting the receive; on a clean
      // shutdown this is the best available, and maxReceiveCount absorbs it.
      release: makeVisible,
    };
  }

  /**
   * Approximate depth — SQS counts are eventually consistent by design.
   * @returns {Promise<{visible: number, inflight: number, deadLetters: number}>} Depth
   */
  async depth() {
    const read = async (url) => {
      if (!url) return {};
      const result = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return result.Attributes ?? {};
    };

    const [main, dlq] = await Promise.all([read(this.queueUrl), read(this.dlqUrl)]);
    return {
      visible: Number(main.ApproximateNumberOfMessages ?? 0),
      inflight: Number(main.ApproximateNumberOfMessagesNotVisible ?? 0),
      deadLetters: Number(dlq.ApproximateNumberOfMessages ?? 0),
    };
  }
}
