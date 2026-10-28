// notch-bridge.js - Spicetify Extension for Notch Desktop
(function notchBridge() {
  if (!window.Spicetify || !Spicetify.Player) {
    setTimeout(notchBridge, 1000);
    return;
  }

  console.log("%c[Notch Bridge] Loaded successfully", "background: #1DB954; color: #000; font-weight: bold; padding: 2px 6px; border-radius: 3px;");

  let lastRevKey = "";

  function parseTrack(item) {
    if (!item) return null;
    const t = item.contextTrack || item.track || item.item || item;
    const meta = t.metadata || item.metadata || {};

    const title = t.name || meta.title || meta["title"] || "";
    let artist = "";
    if (Array.isArray(t.artists) && t.artists.length > 0) {
      artist = t.artists.map(a => a.name).filter(Boolean).join(", ");
    } else {
      artist = meta.artist_name || meta["artist_name"] || meta.artist || "";
    }

    const album = t.album?.name || meta.album_title || meta["album_title"] || "";
    const duration_ms = parseInt(t.duration?.milliseconds || meta.duration || meta["duration"] || 0, 10);
    const uri = t.uri || meta.entity_uri || item.uri || "";

    let image_url = "";
    if (Array.isArray(t.images) && t.images.length > 0) {
      image_url = t.images[0]?.url || "";
    } else if (t.album?.images && t.album.images.length > 0) {
      image_url = t.album.images[0]?.url || "";
    } else {
      image_url = meta.image_url || meta.image_large_url || meta.image_xlarge_url || "";
    }

    if (image_url && image_url.startsWith("spotify:image:")) {
      image_url = "https://i.scdn.co/image/" + image_url.replace("spotify:image:", "");
    }

    if (!title && !uri) return null;

    return {
      title: title || "Unknown Track",
      artist: artist || "Unknown Artist",
      album: album || "",
      duration_ms: duration_ms || 0,
      uri: uri,
      image_url: image_url || ""
    };
  }

  function collectTracks() {
    const items = [];
    const seenUris = new Set();

    function pushRaw(raw) {
      if (!raw) return;
      const parsed = parseTrack(raw);
      if (!parsed) return;
      const key = parsed.uri || `${parsed.title}-${parsed.artist}`;
      if (seenUris.has(key)) return;
      seenUris.add(key);
      items.push(parsed);
    }

    // 1. Spicetify.Queue
    const q = Spicetify.Queue;
    if (q) {
      if (Array.isArray(q.queued)) q.queued.forEach(pushRaw);
      if (Array.isArray(q.nextTracks)) q.nextTracks.forEach(pushRaw);
      if (Array.isArray(q.next_tracks)) q.next_tracks.forEach(pushRaw);
    }

    // 2. Spicetify.Player.data.nextItems
    const pData = Spicetify.Player.data;
    if (pData?.nextItems && Array.isArray(pData.nextItems)) {
      pData.nextItems.forEach(pushRaw);
    }

    // 3. Fallback to Player origin state
    const originQueue = Spicetify.Player.origin?._queue?._state || Spicetify.Player.origin?._queue;
    if (originQueue) {
      if (Array.isArray(originQueue.queued)) originQueue.queued.forEach(pushRaw);
      if (Array.isArray(originQueue.nextTracks)) originQueue.nextTracks.forEach(pushRaw);
    }

    return items;
  }

  async function sendQueue() {
    try {
      const q = Spicetify.Queue;
      const currentRev = q?.queueRevision || q?.revision || "";
      const currentTrack = Spicetify.Player.data?.item?.uri || Spicetify.Player.origin?._state?.item?.uri || "";
      
      const tracks = collectTracks();
      const revKey = `${currentRev}_${currentTrack}_${tracks.length}`;

      if (revKey === lastRevKey && lastRevKey !== "") {
        return;
      }

      if (tracks.length === 0) {
        return;
      }

      lastRevKey = revKey;
      console.log(`[Notch Bridge] Sending ${tracks.length} tracks to Notch (127.0.0.1:4545)...`);

      fetch("http://127.0.0.1:4545/queue", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ tracks: tracks.slice(0, 40) })
      })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.commands) {
          handleCommands(data.commands);
        }
        console.log("[Notch Bridge] Queue delivered successfully to Notch.");
      })
      .catch((e) => {
        console.warn("[Notch Bridge] Failed to send queue:", e);
      });
    } catch (err) {
      console.error("[Notch Bridge] Error in sendQueue:", err);
    }
  }

  function handleCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return;
    for (const cmd of commands) {
      console.log("[Notch Bridge] Executing command:", cmd);
      if (cmd.action === "play" && cmd.uri) {
        if (Spicetify.Player && typeof Spicetify.Player.playUri === "function") {
          Spicetify.Player.playUri(cmd.uri);
        } else if (Spicetify.Platform?.PlayerAPI?.play) {
          Spicetify.Platform.PlayerAPI.play({ uri: cmd.uri }, {}, {});
        }
      } else if (cmd.action === "remove" && cmd.uri) {
        if (typeof Spicetify.removeFromQueue === "function") {
          Spicetify.removeFromQueue([{ uri: cmd.uri }]);
        } else if (Spicetify.Platform?.PlayerAPI?.removeFromQueue) {
          Spicetify.Platform.PlayerAPI.removeFromQueue([{ uri: cmd.uri }]);
        }
      } else if (cmd.action === "clear") {
        if (Spicetify.Platform?.PlayerAPI?.clearQueue) {
          Spicetify.Platform.PlayerAPI.clearQueue();
        }
      }
    }
    lastRevKey = "";
    setTimeout(sendQueue, 250);
  }

  async function pollCommands() {
    try {
      const res = await fetch("http://127.0.0.1:4545/commands");
      if (res.ok) {
        const data = await res.json();
        if (data && data.commands) {
          handleCommands(data.commands);
        }
      }
    } catch (_) {
      // Notch might not be active, ignore
    }
  }

  // Poll for commands frequently (every 400ms) for snappy UI responsiveness
  setInterval(pollCommands, 400);

  // Periodic poll check every 1.5s
  setInterval(sendQueue, 1500);

  // Trigger on song change
  Spicetify.Player.addEventListener("songchange", () => {
    setTimeout(sendQueue, 300);
  });

  // Initial trigger
  setTimeout(sendQueue, 1500);
})();
