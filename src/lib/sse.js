// ---- SSE fan-out per room ----
export const streams = new Map(); // rooms_id_fk -> Set<res>
export const push = (roomId, evt) => {
    for (const res of streams.get(Number(roomId)) || [])
        try { res.write(`data:${JSON.stringify(evt)}\n\n`); } catch { }
};
