/**
 * GPS/Location-related events
 */

export interface LocationUpdatedEvent {
  type: 'gps.location.updated';
  data: {
    deviceId: string;
    userId: string;
    rideId?: string;
    latitude: number;
    longitude: number;
    accuracy: number; // in meters
    altitude?: number;
    heading?: number; // 0-360 degrees
    speed?: number; // in km/h
    updatedAt: Date;
  };
}

export interface RoutePlannedEvent {
  type: 'gps.route.planned';
  data: {
    rideId: string;
    pickupPoint: {
      latitude: number;
      longitude: number;
    };
    dropoffPoint: {
      latitude: number;
      longitude: number;
    };
    routePoints: Array<{
      latitude: number;
      longitude: number;
    }>;
    estimatedDistance: number; // in kilometers
    estimatedDuration: number; // in seconds
    plannedAt: Date;
  };
}

export interface DeviationDetectedEvent {
  type: 'gps.deviation.detected';
  data: {
    rideId: string;
    driverId: string;
    deviationDistance: number; // in meters
    expectedLocation: {
      latitude: number;
      longitude: number;
    };
    actualLocation: {
      latitude: number;
      longitude: number;
    };
    detectedAt: Date;
  };
}

export type GPSEvent =
  | LocationUpdatedEvent
  | RoutePlannedEvent
  | DeviationDetectedEvent;
