import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GatewayClient, GatewayError } from '../gateway/client';
import type { Geocoder, GeocodeCandidate } from '../gateway/geocoding';
import type { RideSessionManager } from '../gateway/ride-session';

export interface ToolContext {
  userId: string;
  gatewayToken: string;
  gw: GatewayClient;
  rides: RideSessionManager;
  geocoder: Geocoder | null;
}

export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function fail(message: string, details?: unknown): CallToolResult {
  const body = details === undefined ? { error: message } : { error: message, ...(isRecord(details) ? details : { details }) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Every tool runs through this so a failure is reported as a tool error with
 * the gateway's real message and code — never a fake success.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GatewayError) {
      const extra: Record<string, unknown> = { httpStatus: error.status };
      if (error.code) extra['code'] = error.code;
      if (isRecord(error.body)) {
        for (const [key, value] of Object.entries(error.body)) {
          if (key !== 'error' && key !== 'code') extra[key] = value;
        }
      }
      if (error.status === 401) {
        extra['hint'] = 'The Wheelers session is no longer valid. Ask the user to reconnect the Wheelers integration.';
      }
      return fail(error.message, extra);
    }
    if (error instanceof ToolError) {
      return fail(error.message, error.details);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const paginationShape = {
  limit: z.number().int().min(1).max(50).optional().describe('Page size (default 20, max 50).'),
  cursor: z.string().optional().describe('Opaque cursor from a previous page (nextCursor).'),
};

export const locationShape = {
  address: z
    .string()
    .min(2)
    .optional()
    .describe('Free-text place or address, e.g. "Chevron Roundabout, Lekki". Geocoded server-side.'),
  lat: z.number().min(-90).max(90).optional().describe('Latitude — use together with lng to skip geocoding.'),
  lng: z.number().min(-180).max(180).optional().describe('Longitude.'),
};

export const LocationSchema = z.object(locationShape);
export type LocationInput = z.infer<typeof LocationSchema>;

export interface ResolvedLocation {
  lat: number;
  lng: number;
  address: string;
}

/**
 * Turn a tool location input into coordinates the gateway accepts. When an
 * address is ambiguous the caller gets the candidates back and must re-call
 * with explicit lat/lng — silently picking one could send a driver to the
 * wrong district.
 */
export async function resolveLocation(
  ctx: ToolContext,
  input: LocationInput,
  label: string,
  options: { pickFirstIfAmbiguous?: boolean } = {},
): Promise<ResolvedLocation> {
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    let address = input.address?.trim();
    if (!address && ctx.geocoder) {
      address = (await ctx.geocoder.reverse(input.lat, input.lng).catch(() => null)) ?? undefined;
    }
    return { lat: input.lat, lng: input.lng, address: address ?? `${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}` };
  }

  const address = input.address?.trim();
  if (!address) {
    throw new ToolError(`${label} needs either an address or lat/lng.`);
  }
  if (!ctx.geocoder) {
    throw new ToolError(
      `${label} was given as text but geocoding is not configured on this server. Pass lat/lng instead.`,
    );
  }

  const candidates = await ctx.geocoder.candidates(address, 3);
  if (candidates.length === 0) {
    throw new ToolError(`Could not find "${address}" on the map. Ask the user for a more specific ${label.toLowerCase()} (landmark, street, area).`);
  }
  if (candidates.length > 1 && !options.pickFirstIfAmbiguous) {
    throw new ToolError(
      `"${address}" matches more than one place. Ask the user which one they mean, then call again with that candidate's lat/lng.`,
      { field: label, candidates },
    );
  }

  const chosen: GeocodeCandidate = candidates[0];
  return { lat: chosen.lat, lng: chosen.lng, address: chosen.formattedAddress };
}
