import type { IncomingMessage, ServerResponse } from 'http';
import { chatClient, rideClient } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { sendJson } from './utils';

interface ChatRouteDeps {
  jwtSecret: string;
}

export function handleGetRideChatMessagesRoute(deps: ChatRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse, params: { rideId: string }) => {
    let user;
    try {
      user = await authenticateHttpUser(req, deps.jwtSecret);
    } catch {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const { rideId } = params;

    // Verify the user is a participant in this ride
    let ride;
    try {
      ride = await rideClient.findWithDriver(rideId);
    } catch {
      return sendJson(res, 404, { error: 'Ride not found' });
    }

    const isRider = ride.riderId === user.id;
    const isDriver = ride.driver?.user?.id === user.id;
    if (!isRider && !isDriver) {
      return sendJson(res, 403, { error: 'You are not a participant in this ride' });
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const result = await chatClient.findByRideId({ rideId, limit, cursor });

    return sendJson(res, 200, {
      items: result.items.map((msg) => ({
        id: msg.id,
        rideId: msg.rideId,
        senderId: msg.senderId,
        senderRole: msg.senderRole,
        content: msg.content,
        createdAt: msg.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    });
  };
}
