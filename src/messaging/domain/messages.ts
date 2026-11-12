import type { IntegrationEvent } from './integration-event';
export class InboxMessage {
  #processedAt:Date|undefined;
  private constructor(readonly consumerName:string,readonly messageId:string,readonly payloadHash:string,private readonly received:number,processedAt?:Date){this.#processedAt=processedAt?new Date(processedAt):undefined;Object.freeze(this);}
  static receive(consumerName:string,messageId:string,payloadHash:string,at=new Date()):InboxMessage{
    if(!consumerName||!messageId||!/^[a-f0-9]{64}$/.test(payloadHash))throw new Error('Invalid inbox identity');
    return new InboxMessage(consumerName,messageId,payloadHash,at.getTime());
  }
  static rehydrate(state:{consumerName:string;messageId:string;payloadHash:string;receivedAt:Date;processedAt?:Date}):InboxMessage{
    return new InboxMessage(state.consumerName,state.messageId,state.payloadHash,state.receivedAt.getTime(),state.processedAt);
  }
  get receivedAt():Date{return new Date(this.received);}
  get processedAt():Date|undefined{return this.#processedAt?new Date(this.#processedAt):undefined;}
  isProcessed():boolean{return this.#processedAt!==undefined;}
  markProcessed(at:Date):void{if(this.isProcessed())throw new Error('Inbox already processed');this.#processedAt=new Date(at);}
}
interface OutboxState {id:string;aggregateId:string;eventType:string;payload:Record<string,unknown>;occurredAt:Date;attempts:number;nextAttemptAt?:Date;publishedAt?:Date}
export class OutboxMessage {
  #attempts:number;#next:number|undefined;#published:number|undefined;
  private readonly json:string;
  private constructor(private readonly state:OutboxState){this.json=JSON.stringify(state.payload);this.#attempts=state.attempts;this.#next=state.nextAttemptAt?.getTime();this.#published=state.publishedAt?.getTime();}
  static enqueue(event:IntegrationEvent<Record<string,unknown>>):OutboxMessage{return new OutboxMessage({id:event.eventId,aggregateId:event.aggregateId,eventType:event.eventType,payload:event.toJSON(),occurredAt:new Date(event.occurredAt),attempts:0});}
  static rehydrate(state:OutboxState):OutboxMessage{return new OutboxMessage({...state,occurredAt:new Date(state.occurredAt)});}
  get id():string{return this.state.id;}get aggregateId():string{return this.state.aggregateId;}get eventType():string{return this.state.eventType;}
  get payload():Record<string,unknown>{return JSON.parse(this.json) as Record<string,unknown>;}
  get occurredAt():Date{return new Date(this.state.occurredAt);}
  get attempts():number{return this.#attempts;}
  get nextAttemptAt():Date|undefined{return this.#next===undefined?undefined:new Date(this.#next);}
  get publishedAt():Date|undefined{return this.#published===undefined?undefined:new Date(this.#published);}
  isPending():boolean{return this.#published===undefined;}
  isDue(now:Date):boolean{return this.isPending()&&(this.#next===undefined||this.#next<=now.getTime());}
  markPublished(at:Date):void{if(!this.isPending())throw new Error('Outbox already published');this.#attempts++;this.#published=at.getTime();}
  scheduleRetry(now:Date):void{if(!this.isPending())throw new Error('Outbox already published');this.#next=now.getTime()+Math.min(60000,1000*2**Math.min(this.#attempts,6));this.#attempts++;}
}
