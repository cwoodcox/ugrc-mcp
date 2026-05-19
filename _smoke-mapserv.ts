import {
  geocodeAddress,
  reverseGeocode,
  geocodeMilepost,
  listSgidTables,
} from "./src/tools/mapserv.ts";

const env = { UGRC_API_KEY: process.env.UGRC_API_KEY ?? "" } as any;

const fail = (label: string, err: unknown) => {
  console.error(`✗ ${label}:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
};
const ok = (label: string, body: unknown) =>
  console.log(`✓ ${label}:\n${JSON.stringify(body, null, 2)}\n`);

try {
  const r = await reverseGeocode(
    { x: -111.891, y: 40.7608, spatial_reference: 4326, distance: 5 },
    env,
  );
  ok("reverse_geocode {-111.891, 40.7608} (AC #4)", r);
} catch (e) {
  fail("reverse_geocode", e);
}

try {
  const r = await geocodeAddress(
    {
      street: "326 East South Temple",
      zone: "Salt Lake City",
      spatial_reference: 4326,
    },
    env,
  );
  ok("geocode_address (AC #5)", r);
} catch (e) {
  fail("geocode_address", e);
}

try {
  const r = await geocodeMilepost(
    { route: "0015", milepost: 305, spatial_reference: 4326 },
    env,
  );
  ok("geocode_milepost {0015, 305}", r);
} catch (e) {
  fail("geocode_milepost", e);
}

try {
  const r = await listSgidTables({ category: "cadastre" }, env);
  ok("list_sgid_tables {cadastre}", r);
} catch (e) {
  fail("list_sgid_tables", e);
}
