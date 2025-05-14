import { publishDOMEEvent, getActiveDOMEEventsByDate } from "../api/DLTInterface";
import express from "express";
import debug from "debug";
import { IllegalArgumentError } from "../exceptions/IllegalArgumentError";
import { NotificationEndpointError } from "../exceptions/NotificationEndpointError";
import notifier from "../subscriber/notifier";

const router = express.Router();
const debugLog = debug("Routes: ");
const errorLog = debug("Routes:error ");

router.get("/health", (req: any, resp: any) => {
  const healthCheckResponse = {
    status: "UP",
    checks: [
      {
        name: "DLT Adapter health check",
        status: "UP",
      },
    ],
  };
  resp.status(200).json(healthCheckResponse);
});

router.post("/api/v1/publishEvent", async (req: any, resp: any) => {
  debugLog("Entry call from origin: ", req.headers.origin);
  try {
    let eventTimestamp = await publishDOMEEvent(
        req.body.eventType,
        req.body.dataLocation,
        req.body.relevantMetadata,
        req.body.iss ?? process.env.ISS,
        req.body.entityId,
        req.body.previousEntityHash,
        req.body.rpcAddress ?? process.env.RPC_ADDRESS
    );
    resp.status(201).json(eventTimestamp);
  } catch (error: any) {
    if (error == IllegalArgumentError) {
      errorLog("Error:\n ", error);
      resp.status(400).send(error.message);
    }

    errorLog("Error:\n ", error);
    resp.status(400).send("Error connecting to the blockchain node.");
  }
});

router.post("/api/v1/subscribe", async (req: any, resp: any) => {
  debugLog("Entry call from origin: ", req.headers.origin);
  try {
    const eventTypes = req.body.eventTypes;
    if (eventTypes === undefined || eventTypes === null) {
      throw new IllegalArgumentError("The eventType is null.");
    }

    if (eventTypes.length === 0) {
      throw new IllegalArgumentError("No eventTypes indicated for subscription.");
    }

    if (eventTypes.includes("")) {
      throw new IllegalArgumentError("Blank eventTypes indicated for subscription.");
    }

    const notificationEndpoint = req.body.notificationEndpoint;
    if (notificationEndpoint === undefined || notificationEndpoint === null || notificationEndpoint === "") {
      throw new IllegalArgumentError("Blank eventTypes indicated for subscription.");
    }

    notifier.add(notificationEndpoint, {eventTypes: eventTypes, ownIss: process.env.ISS!});

    resp.status(201).send("OK");
  } catch (error: any) {
    if (error == NotificationEndpointError) {
      errorLog("Error:\n ", error);
      resp.status(400).send(error.message);
    }

    debugLog("Error:\n ", error);
    resp.status(400).send("Error connecting to the blockchain node.");
  }
});

router.get('/api/v1/events', async (req: any, resp: any) => {
  debugLog("Entry call from origin: ", req.headers.origin);
  try {
    let activeEvents = await getActiveDOMEEventsByDate(req.query.startDate, req.query.endDate, process.env.RPC_ADDRESS!);
    resp.status(200).json(activeEvents);
  } catch (error: any) {
    if (error == IllegalArgumentError) {
      errorLog("Error:\n ", error);
      resp.status(400).send(error.message);
    }
    debugLog("Error:\n ", error);
    resp.status(400).send("Error connecting to the blockchain.");
  }
})

export = router;
