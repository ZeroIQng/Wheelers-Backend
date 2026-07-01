import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type ComplianceEvent,
  type CryptoWalletEvent,
  type DriverEvent,
  type GpsUpdateEvent,
  type GroupRideEvent,
  type NotificationEvent,
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

  async publishGroupRideEvent(event: GroupRideEvent): Promise<void> {
    const key =
      'groupId' in event && typeof event.groupId === 'string'
        ? event.groupId
        : 'rideId' in event && typeof event.rideId === 'string'
          ? event.rideId
          : event.eventType;

    await this.producer.send(TOPICS.GROUP_RIDE_EVENTS, event, { key });
  }

  async publishPaymentEvent(event: PaymentEvent): Promise<void> {
    await this.producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
  }

  async publishNotificationEvent(event: NotificationEvent): Promise<void> {
    await this.producer.send(TOPICS.NOTIFICATION_EVENTS, event, { key: event.userId });
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

  async publishCryptoWalletEvent(event: CryptoWalletEvent): Promise<void> {
    await this.producer.send(TOPICS.CRYPTO_WALLET_EVENTS, event, { key: event.userId });
  }
}
