export interface EventContext { correlationId: string; causationId?: string }
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId = crypto.randomUUID();
  protected constructor(readonly aggregateId: string, readonly context: EventContext,
    readonly occurredAt: Date, readonly data: Readonly<T>) {}
  toJSON() {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.context.correlationId,
      ...(this.context.causationId === undefined ? {} : { causationId: this.context.causationId }),
      occurredAt: this.occurredAt.toISOString(), data: this.data };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  constructor(id: string, ctx: EventContext, at: Date, data: Record<string, unknown>) { super(id, ctx, at, data); }
}
export class WagerTransactionFailed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionFailed'; readonly version = 1;
  constructor(id: string, ctx: EventContext, at: Date, data: Record<string, unknown>) { super(id, ctx, at, data); }
}
export class WagerTransactionRejected extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  constructor(id: string, ctx: EventContext, at: Date, data: Record<string, unknown>) { super(id, ctx, at, data); }
}
export class WalletBalanceChanged extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  constructor(id: string, ctx: EventContext, at: Date, data: Record<string, unknown>) { super(id, ctx, at, data); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  constructor(id: string, ctx: EventContext, at: Date, data: Record<string, unknown>) { super(id, ctx, at, data); }
}
