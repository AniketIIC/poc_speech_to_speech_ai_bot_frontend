import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

type AudioPayload = {
  audioChunkNo: number; // ignored for playback order; kept for parity
  audio: string;
  conversationId: string;
};

type PlayableChunk = {
  audio: string;
};

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:5050";
const AUDIO_SAMPLE_RATE = 44100;

const base64ToUint8Array = (base64: string): Uint8Array => {
  const cleaned = base64.split(",").pop() ?? "";
  const binary = atob(cleaned);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = (reader.result as string) || "";
      const cleaned = result.includes(",") ? result.split(",")[1] : result;
      resolve(cleaned);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const createAudioBuffer = async (
  base64Audio: string,
  audioCtx: AudioContext
) => {
  const uint8 = base64ToUint8Array(base64Audio);
  const view = new DataView(uint8.buffer);
  const samples = uint8.byteLength / 4;
  const float32 = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    float32[i] = view.getFloat32(i * 4, true);
  }
  const buffer = audioCtx.createBuffer(1, float32.length, AUDIO_SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);
  return buffer;
};

function App() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle");

  const socketRef = useRef<Socket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackQueueRef = useRef<PlayableChunk[]>([]);
  const playingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const pendingChunksRef = useRef(0);
  const endRequestedRef = useRef(false);

  const resetPlayback = useCallback(() => {
    playbackQueueRef.current = [];
    playingRef.current = false;
  }, []);

  const resetAudioContext = useCallback(async () => {
    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
  }, []);

  const cleanupMedia = useCallback(() => {
    pendingChunksRef.current = 0;
    endRequestedRef.current = false;
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // no-op
      }
    }
    mediaRecorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    setIsHolding(false);
  }, []);

  const playNextChunk = useCallback(async () => {
    if (playingRef.current) return;
    const queue = playbackQueueRef.current;
    if (!queue.length) return;

    const next = queue.shift()!;

    try {
      const audioCtx =
        audioContextRef.current ??
        new AudioContext({
          sampleRate: AUDIO_SAMPLE_RATE,
        });
      audioContextRef.current = audioCtx;
      await audioCtx.resume();

      const buffer = await createAudioBuffer(next.audio, audioCtx);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);

      playingRef.current = true;
      source.onended = () => {
        playingRef.current = false;
        void playNextChunk();
      };
      source.start();
    } catch (err) {
      console.error("Failed to play audio chunk", err);
      playingRef.current = false;
      void playNextChunk();
    }
  }, []);

  const handleAudioEvent = useCallback(
    (payload: AudioPayload) => {
      console.log(payload.conversationId, conversationIdRef.current);
      if (!payload?.conversationId) return;
      if (payload.conversationId !== conversationIdRef.current) return;
      if (!payload.audio) return;

      playbackQueueRef.current.push({
        audio: payload.audio,
      });

      void playNextChunk();
    },
    [playNextChunk]
  );

  const tryEmitEndStream = useCallback(() => {
    if (!endRequestedRef.current) return;
    if (pendingChunksRef.current > 0) return;
    socketRef.current?.emit("end_stream");
    endRequestedRef.current = false;
    setStatusMessage("Stream ended");
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketConnected(true);
      setStatusMessage("Connected to backend");
    });

    socket.on("disconnect", () => {
      setSocketConnected(false);
      setStatusMessage("Disconnected");
      setConversationId(null);
      conversationIdRef.current = null;
      resetPlayback();
      void resetAudioContext();
      cleanupMedia();
    });

    socket.on("new_conversation", ({ data }) => {
      const nextConversation = data?.conversationId ?? null;
      conversationIdRef.current = nextConversation;
      console.log(conversationIdRef.current);
      setConversationId(nextConversation);
      resetPlayback();
      void resetAudioContext();
      setStatusMessage(
        nextConversation
          ? `New conversation: ${nextConversation}`
          : "Awaiting conversation"
      );
    });

    socket.on("audio", ({ data }) => handleAudioEvent(data as AudioPayload));

    socket.on("processing_error", (payload) => {
      setStatusMessage(payload?.message || "Processing error");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      cleanupMedia();
      resetPlayback();
      void resetAudioContext();
    };
  }, [cleanupMedia, handleAudioEvent, resetAudioContext, resetPlayback]);

  const startHoldingToTalk = async () => {
    if (isHolding) return;
    if (!socketRef.current || !socketConnected) {
      setStatusMessage("Socket not connected");
      return;
    }

    try {
      pendingChunksRef.current = 0;
      endRequestedRef.current = false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (event) => {
        if (event.data.size <= 0) return;
        try {
          pendingChunksRef.current += 1;
          const base64 = await blobToBase64(event.data);
          socketRef.current?.emit("audio_chunk", { data: base64 });
        } catch (err) {
          console.error("Failed to encode audio chunk", err);
        } finally {
          pendingChunksRef.current = Math.max(0, pendingChunksRef.current - 1);
          tryEmitEndStream();
        }
      };

      recorder.onstop = () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        mediaRecorderRef.current = null;
        setIsHolding(false);
        tryEmitEndStream();
      };

      recorder.onerror = (err) => {
        console.error("Recorder error", err);
        setStatusMessage("Recorder error");
      };

      socketRef.current.emit("start_stream");
      setIsHolding(true);
      setStatusMessage("Streaming audio...");
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({
          sampleRate: AUDIO_SAMPLE_RATE,
        });
      }
      await audioContextRef.current.resume();
      recorder.start(2000);
    } catch (err) {
      console.error("Microphone unavailable", err);
      setStatusMessage("Microphone unavailable");
      cleanupMedia();
    }
  };

  const stopHoldingToTalk = () => {
    if (!isHolding) return;
    endRequestedRef.current = true;

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
    } else {
      cleanupMedia();
      tryEmitEndStream();
    }
  };

  const resetStream = async () => {
    cleanupMedia();
    resetPlayback();
    conversationIdRef.current = null;
    setConversationId(null);
    setStatusMessage("Reset");
    socketRef.current?.emit("reset_stream");
    await resetAudioContext();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">AI Stack Demo</p>
          <h1>Push-to-Talk Mic</h1>
          <p className="lede">
            Hold the button to stream audio. Release to end and let the backend
            reply with TTS.
          </p>
        </div>
        <div className="status-pill">
          <span
            className={`dot ${socketConnected ? "ok" : "warn"}`}
            aria-hidden
          />
          {socketConnected ? "Connected" : "Disconnected"}
        </div>
      </header>

      <section className="card">
        <div className="row">
          <div>
            <p className="label">Conversation</p>
            <p className="value">
              {conversationId ? conversationId : "Waiting for server..."}
            </p>
          </div>
          <div>
            <p className="label">Status</p>
            <p className="value">{statusMessage}</p>
          </div>
        </div>

        <div className="mic-area">
          <div className="action-row">
            <button
              className={`mic-button ${isHolding ? "active" : ""}`}
              onMouseDown={startHoldingToTalk}
              onMouseUp={stopHoldingToTalk}
              onMouseLeave={stopHoldingToTalk}
              onTouchStart={(e) => {
                e.preventDefault();
                startHoldingToTalk();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                stopHoldingToTalk();
              }}
              onTouchCancel={(e) => {
                e.preventDefault();
                stopHoldingToTalk();
              }}
              disabled={!socketConnected}
            >
              {isHolding ? "Streaming..." : "Hold to Talk"}
            </button>
            <button
              className="secondary-button"
              onClick={resetStream}
              disabled={!socketConnected}
            >
              Reset
            </button>
          </div>
          <p className="hint">
            Sends `start_stream` on press, base64 audio chunks every 2s while
            held, and `end_stream` on release.
          </p>
        </div>
      </section>
    </div>
  );
}

export default App;
