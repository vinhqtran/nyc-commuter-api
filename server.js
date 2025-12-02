const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { transit_realtime } = require("gtfs-realtime-bindings");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 1) Load FULL station config generated from GTFS ----
const fullStationConfig = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "config", "stations_backend_full.json"),
    "utf8"
  )
);

// Optional: you can still keep a manual overrides file if you want later
console.log("Loaded full stations:", Object.keys(fullStationConfig).length);

// ---- 2) Alias map for backward compatibility ----
// Keys = what the iOS app sends as stationId
// Values = station keys from stations_backend_full.json
const stationAlias = {
  // Keep your existing app working:
  "34_herald_sq_bdfm": "D17" // <-- replace "D17" with the actual key if different
  // Later: add more aliases if you want friendly IDs
};

// Base MTA realtime endpoint – we append the feed name like "nyct%2Fgtfs-bdfm"
const MTA_BASE_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds";

// ---- 3) Helper: fetch a GTFS feed by feedName ----
function fetchGtfsFeed(feedName) {
  const url = `${MTA_BASE_URL}/${feedName}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`MTA feed returned status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

// ---- 4) Main arrivals API powered by full station config ----
app.get("/api/arrivals", async (req, res) => {
  try {
    const stationIdRaw = req.query.stationId;
    const linesParam = req.query.lines; // e.g. "B,D,F,M"
    const requestedLines = linesParam ? linesParam.split(",") : [];

    if (!stationIdRaw) {
      return res.status(400).json({ error: "stationId is required" });
    }

    // Map legacy IDs (like "34_herald_sq_bdfm") -> full config keys (like "D17")
    const stationKey = stationAlias[stationIdRaw] || stationIdRaw;
    const station = fullStationConfig[stationKey];

    if (!station) {
      return res
        .status(400)
        .json({ error: `Unknown stationId: ${stationIdRaw}` });
    }

    // Lines available at this station from config
    const availableLines = station.lines ? Object.keys(station.lines) : [];

    // If client requested specific lines, intersect with available ones
    const effectiveLines =
      requestedLines.length > 0
        ? availableLines.filter((l) => requestedLines.includes(l))
        : availableLines;

    if (effectiveLines.length === 0) {
      console.log(
        `API: station=${stationKey}, requested=${requestedLines.join(
          ","
        )}, but none available at this station.`
      );
      return res.json([]);
    }

    // station.feeds is an array of feed names like "nyct%2Fgtfs-bdfm"
    const feedNames = station.feeds || [];
    if (feedNames.length === 0) {
      console.warn(`Station ${stationKey} has no feeds configured.`);
      return res.json([]);
    }

    const results = [];

    // You can parallelize these later, but serial is fine for now
    for (const feedName of feedNames) {
      const feedData = await fetchGtfsFeed(feedName);
      const feed = transit_realtime.FeedMessage.decode(feedData);

      console.log(
        `API: station=${stationKey}, feed=${feedName}, entityCount=${feed.entity.length}`
      );

      for (const entity of feed.entity) {
        if (!entity.tripUpdate) continue;
        const tripUpdate = entity.tripUpdate;

        const routeId =
          (tripUpdate.trip &&
            (tripUpdate.trip.routeId || tripUpdate.trip.routeID)) ||
          "UNKNOWN";

        // Only consider lines relevant to this station + user
        if (!effectiveLines.includes(routeId)) continue;

        const lineConfig = station.lines[routeId];
        if (!lineConfig) continue;

        for (const stu of tripUpdate.stopTimeUpdate) {
          const stopId = stu.stopId || stu.stopID || "UNKNOWN";

          let direction = null;
          if (lineConfig.uptown.includes(stopId)) direction = "uptown";
          if (lineConfig.downtown.includes(stopId)) direction = "downtown";
          if (!direction) continue;

          let rawTime = null;
          if (stu.arrival && stu.arrival.time != null) {
            rawTime = stu.arrival.time;
          } else if (stu.departure && stu.departure.time != null) {
            rawTime = stu.departure.time;
          }
          if (rawTime == null) continue;

          const t = Number(rawTime);
          if (!Number.isFinite(t)) continue;

          const isoTime = new Date(t * 1000).toISOString();

          results.push({
            line: routeId,
            direction,
            arrivalTime: isoTime
          });
        }
      }
    }

    results.sort(
      (a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime)
    );

    console.log(
      `API: station=${stationKey}, lines=${effectiveLines.join(
        ","
      )}, results=${results.length}`
    );

    res.json(results);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "Failed to fetch arrivals" });
  }
});

// ---- 5) Debug endpoint (still using BDFM feed for raw inspection) ----
app.get("/debug/raw-arrivals", async (req, res) => {
  try {
    // You can choose any feed to debug; using BDFM here:
    const bdfmFeedName = "nyct%2Fgtfs-bdfm";
    const feedData = await fetchGtfsFeed(bdfmFeedName);
    const feed = transit_realtime.FeedMessage.decode(feedData);

    console.log("DEBUG: feed.entity.length =", feed.entity.length);

    const results = [];

    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      const tripUpdate = entity.tripUpdate;

      const routeId =
        tripUpdate.trip?.routeId || tripUpdate.trip?.routeID || "UNKNOWN";

      for (const stu of tripUpdate.stopTimeUpdate) {
        const stopId = stu.stopId || stu.stopID || "UNKNOWN";

        results.push({
          line: routeId,
          stopId: stopId
        });

        if (results.length >= 100) break;
      }

      if (results.length >= 100) break;
    }

    if (results.length === 0 && feed.entity.length > 0) {
      console.log(
        "DEBUG: first entity =",
        JSON.stringify(feed.entity[0], null, 2)
      );
    }

    res.json(results);
  } catch (err) {
    console.error("DEBUG error:", err);
    res.status(500).json({ error: "Failed to fetch debug arrivals" });
  }
});

// ---- 6) Stations endpoint for the iOS app ----
app.get("/stations", (req, res) => {
  try {
    const stations = Object.entries(fullStationConfig).map(([id, cfg]) => ({
      id,
      name: cfg.name,
      lines: Object.keys(cfg.lines || {}),
      latitude: cfg.latitude,
      longitude: cfg.longitude
    }));

    // Optional: sort alphabetically by name
    stations.sort((a, b) => a.name.localeCompare(b.name));

    res.json(stations);
  } catch (err) {
    console.error("/stations error:", err);
    res.status(500).json({ error: "Failed to load stations" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
