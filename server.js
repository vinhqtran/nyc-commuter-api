const express = require("express");
const https = require("https");
const { transit_realtime } = require("gtfs-realtime-bindings");

const app = express();
const PORT = process.env.PORT || 3000;

// Just the feed URL now – no key needed for subway
const MTA_FEED_URL =
  process.env.MTA_FEED_URL ||
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm";

// if (!MTA_API_KEY || !MTA_FEED_URL) {
 // console.warn("⚠️ Set MTA_API_KEY and MTA_FEED_URL in your environment.");


const stationGTFSMap = {
  "14_st_8_av": {
    uptownStopIds: ["STOP_ID_14ST_UP_1"],
    downtownStopIds: ["STOP_ID_14ST_DOWN_1"],
  },
  "34_herald_sq_bdfm": {
    uptownStopIds: ["D17N"],
    downtownStopIds: ["D17S"],
  },
  "times_sq_42": {
    uptownStopIds: ["STOP_ID_TIMESSQ_UP_1"],
    downtownStopIds: ["STOP_ID_TIMESSQ_DOWN_1"],
  },
};

console.log("stationGTFSMap keys:", Object.keys(stationGTFSMap));


function fetchGtfsFeed(url) {
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

app.get("/api/arrivals", async (req, res) => {
  try {
    const stationId = req.query.stationId;
    const linesParam = req.query.lines; // e.g. "B,D,F,M"
    const favoriteLines = linesParam ? linesParam.split(",") : [];

    if (!stationId) {
      return res.status(400).json({ error: "stationId is required" });
    }

    const mapping = stationGTFSMap[stationId];
    if (!mapping) {
      return res.status(400).json({ error: "Unknown stationId" });
    }

    const feedData = await fetchGtfsFeed(MTA_FEED_URL);
    const feed = transit_realtime.FeedMessage.decode(feedData);

    const results = [];

    console.log("API: feed.entity.length =", feed.entity.length);

    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      const tripUpdate = entity.tripUpdate;

      const routeId =
        (tripUpdate.trip && (tripUpdate.trip.routeId || tripUpdate.trip.routeID)) ||
        "UNKNOWN";

      // Only keep user’s favorite lines (if any)
      if (favoriteLines.length && !favoriteLines.includes(routeId)) {
        continue;
      }

      for (const stu of tripUpdate.stopTimeUpdate) {
        const stopId = stu.stopId || stu.stopID || "UNKNOWN";

        // Only Herald Sq BDFM stops
        let direction = null;
        if (mapping.uptownStopIds.includes(stopId)) direction = "uptown";
        if (mapping.downtownStopIds.includes(stopId)) direction = "downtown";
        if (!direction) continue;

        // Try arrival, then departure
        let rawTime = null;
        if (stu.arrival && stu.arrival.time != null) {
          rawTime = stu.arrival.time;
        } else if (stu.departure && stu.departure.time != null) {
          rawTime = stu.departure.time;
        }
        if (rawTime == null) continue;

        const t = Number(rawTime);
        if (!Number.isFinite(t)) continue;

        // 👉 IMPORTANT: do NOT filter by t > now for now
        const isoTime = new Date(t * 1000).toISOString();

        results.push({
          line: routeId,
          direction,
          arrivalTime: isoTime,
        });
      }
    }

    results.sort(
      (a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime)
    );

    console.log("API: filtered results =", results.length);
    res.json(results);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "Failed to fetch arrivals" });
  }
});

app.get("/debug/raw-arrivals", async (req, res) => {
  try {
    const feedData = await fetchGtfsFeed(MTA_FEED_URL);
    const feed = transit_realtime.FeedMessage.decode(feedData);

    console.log("DEBUG: feed.entity.length =", feed.entity.length);

    const results = [];

    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      const tripUpdate = entity.tripUpdate;

      const routeId = tripUpdate.trip?.routeId || tripUpdate.trip?.routeID || "UNKNOWN";

      for (const stu of tripUpdate.stopTimeUpdate) {
        const stopId = stu.stopId || stu.stopID || "UNKNOWN";

        results.push({
          line: routeId,
          stopId: stopId,
        });

        if (results.length >= 100) break;
      }

      if (results.length >= 100) break;
    }

    // If still nothing, log the first entity so we can inspect shape
    if (results.length === 0 && feed.entity.length > 0) {
      console.log("DEBUG: first entity =", JSON.stringify(feed.entity[0], null, 2));
    }

    res.json(results);
  } catch (err) {
    console.error("DEBUG error:", err);
    res.status(500).json({ error: "Failed to fetch debug arrivals" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
