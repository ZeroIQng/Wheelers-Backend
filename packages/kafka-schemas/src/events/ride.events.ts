/**
 * Ride-related events
 */

export interface RideRequestedEvent {
  type: 'ride.requested';
  data: {
    rideId: string;
    passengerId: string;
    pickupLocation: {
      latitude: number;
      longitude: number;
      address: string;
    };
    dropoffLocation: {
      latitude: number;
      longitude: number;
      address: string;
    };
    requestedAt: Date;
    estimatedFare: number;
  };
}

export interface RideAcceptedEvent {
  type: 'ride.accepted';
  data: {
    rideId: string;
    driverId: string;
    acceptedAt: Date;
    estimatedArrivalTime: number; // in seconds
  };
}

export interface RideStartedEvent {
  type: 'ride.started';
  data: {
    rideId: string;
    driverId: string;
    startedAt: Date;
  };
}

export interface RideCompletedEvent {
  type: 'ride.completed';
  data: {
    rideId: string;
    driverId: string;
    passengerId: string;
    completedAt: Date;
    distance: number; // in kilometers
    duration: number; // in seconds
    finalFare: number;
  };
}

export interface RideCancelledEvent {
  type: 'ride.cancelled';
  data: {
    rideId: string;
    cancelledBy: 'passenger' | 'driver';
    reason: string;
    cancelledAt: Date;
  };
}

export type RideEvent =
  | RideRequestedEvent
  | RideAcceptedEvent
  | RideStartedEvent
  | RideCompletedEvent
  | RideCancelledEvent;
