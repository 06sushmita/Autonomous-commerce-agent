/**
 * Real-Time Dynamic Geocoding Service
 * Dynamically resolves GPS coordinates (latitude, longitude) and geographic metadata
 * for ANY arbitrary user-specified address and pincode in India.
 *
 * Strict Policy:
 *  - ZERO hardcoded address fallbacks.
 *  - User can enter any address in any city or state.
 *  - Real-time resolution via OpenStreetMap Nominatim with postalpincode.in fallback.
 */

export interface GeocodedLocation {
  latitude: number;
  longitude: number;
  city?: string;
  state?: string;
  displayName?: string;
  source: 'nominatim' | 'postalpincode' | 'cache' | 'provided';
}

const geocodeCache = new Map<string, GeocodedLocation>();

export async function geocodeAddress(
  address: string,
  pincode: string,
  city?: string
): Promise<GeocodedLocation | null> {
  const cleanPin = (pincode || '').trim();
  const cleanAddr = (address || '').trim();
  const cacheKey = `${cleanPin}_${cleanAddr}`.toLowerCase();

  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  // 1. Try Nominatim with clean queries
  const queries = [
    `${cleanAddr}, ${cleanPin}, India`,
    `${cleanPin}, India`,
    `${cleanAddr}, India`,
  ];

  for (const q of queries) {
    if (!q.trim() || q.trim() === 'India' || q.trim() === ', India') continue;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
        q
      )}&format=json&limit=1&countrycodes=in`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'AutonomousCommerceAgent/1.0 (Dynamic Quick-Commerce Geocoding)',
          Accept: 'application/json',
        },
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as any[];
        if (data && data.length > 0 && data[0].lat && data[0].lon) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          if (!isNaN(lat) && !isNaN(lon)) {
            const result: GeocodedLocation = {
              latitude: lat,
              longitude: lon,
              city: city || data[0].address?.city || data[0].address?.town || data[0].address?.district,
              state: data[0].address?.state,
              displayName: data[0].display_name,
              source: 'nominatim',
            };
            geocodeCache.set(cacheKey, result);
            return result;
          }
        }
      }
    } catch {
      // Continue to next query or fallback
    }
  }

  // 2. Fallback: Query postalpincode.in for postal circle/district
  if (/^\d{6}$/.test(cleanPin)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`https://api.postalpincode.in/pincode/${cleanPin}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AutonomousCommerceAgent/1.0' },
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as any[];
        const po = data?.[0]?.PostOffice?.[0];
        if (po && (po.District || po.State)) {
          const districtQuery = `${po.District || po.Name}, ${po.State}, India`;
          const districtRes = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
              districtQuery
            )}&format=json&limit=1&countrycodes=in`,
            { headers: { 'User-Agent': 'AutonomousCommerceAgent/1.0' } }
          );
          if (districtRes.ok) {
            const dData = (await districtRes.json()) as any[];
            if (dData?.[0]?.lat && dData?.[0]?.lon) {
              const result: GeocodedLocation = {
                latitude: parseFloat(dData[0].lat),
                longitude: parseFloat(dData[0].lon),
                city: po.District || po.Name,
                state: po.State,
                displayName: `${po.Name}, ${po.District}, ${po.State} - ${cleanPin}`,
                source: 'postalpincode',
              };
              geocodeCache.set(cacheKey, result);
              return result;
            }
          }
        }
      }
    } catch {
      // Return null if unreachable
    }
  }

  return null;
}
