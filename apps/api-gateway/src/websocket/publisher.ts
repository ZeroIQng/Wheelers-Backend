import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type ComplianceEvent,
  type DriverEvent,
  type GpsUpdateEvent,
  type PaymentEvent,
  type RideEvent,
  type UserEvent,
} from '@wheleers/kafka-schemas';

export class GatewayPublisher {
  constructor(private readonly producer: WheelersProducer) {}

  async publishUserEvent(event: UserEvent): Promise<void> {
    await this.producer.send(TOPICS.USER_EVENTS, event, { key: event.userId });
  }

  async publishDriverEvent(event: DriverEvent): Promise<void> {
    await this.producer.send(TOPICS.DRIVER_EVENTS, event, { key: event.driverId });
  }

  async publishRideEvent(event: RideEvent): Promise<void> {
    await this.producer.send(TOPICS.RIDE_EVENTS, event, { key: event.rideId });
  }

  async publishPaymentEvent(event: PaymentEvent): Promise<void> {
    await this.producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
  }

  async publishGpsEvent(event: GpsUpdateEvent): Promise<void> {
    await this.producer.send(TOPICS.GPS_STREAM, event, { key: event.driverId });
  }

  async publishComplianceEvent(event: ComplianceEvent): Promise<void> {
    const key =
      'rideId' in event && typeof event.rideId === 'string'
        ? event.rideId
        : 'userId' in event && typeof event.userId === 'string'
          ? event.userId
          : event.eventType;

    await this.producer.send(TOPICS.COMPLIANCE_EVENTS, event, { key });
  }
}
