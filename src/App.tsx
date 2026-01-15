import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:5050";
const SAMPLE_RATE = 24000;
const CHUNK_MS = 2000;
const SAMPLES_PER_CHUNK = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000);

const downsample = (
  buffer: Float32Array,
  inputRate: number,
  outputRate: number
) => {
  if (outputRate === inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offset = 0;
  for (let i = 0; i < newLen; i++) {
    result[i] = buffer[Math.floor(offset)];
    offset += ratio;
  }
  return result;
};

const floatTo16BitPCM = (input: Float32Array) => {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (b64: string) => {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const int16ToBase64 = (input: Int16Array) => {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    view.setInt16(i * 2, input[i], true);
  }
  return arrayBufferToBase64(buffer);
};

const getConversationId = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const casted = payload as {
    conversationId?: string | null;
    data?: { conversationId?: string | null };
  };
  return casted.conversationId ?? casted.data?.conversationId ?? null;
};

function App() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle");

  const socketRef = useRef<Socket | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const pendingSegmentsRef = useRef<Int16Array[]>([]);
  const pendingSamplesRef = useRef(0);
  const isSendingInputRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playheadTimeRef = useRef(0);

  const ensureAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
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

  const stopOutputPlayback = useCallback(() => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch {
        // ignore
      }
    });
    activeSourcesRef.current = [];
    playheadTimeRef.current = audioContextRef.current?.currentTime || 0;
  }, []);

  const cleanupInput = useCallback(() => {
    processorNodeRef.current?.disconnect();
    processorNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    pendingSegmentsRef.current = [];
    pendingSamplesRef.current = 0;
    isSendingInputRef.current = false;
    setIsHolding(false);
  }, []);

  const drainInputChunks = useCallback((force = false) => {
    const chunkSize = SAMPLES_PER_CHUNK;
    while (
      pendingSamplesRef.current >= chunkSize ||
      (force && pendingSamplesRef.current > 0)
    ) {
      const targetLength = Math.min(chunkSize, pendingSamplesRef.current);
      if (targetLength <= 0) break;

      const chunk = new Int16Array(targetLength);
      let offset = 0;

      while (offset < targetLength && pendingSegmentsRef.current.length) {
        const segment = pendingSegmentsRef.current[0];
        const toCopy = Math.min(segment.length, targetLength - offset);
        chunk.set(segment.subarray(0, toCopy), offset);
        offset += toCopy;

        if (toCopy === segment.length) {
          pendingSegmentsRef.current.shift();
        } else {
          pendingSegmentsRef.current[0] = segment.subarray(toCopy);
        }
      }

      pendingSamplesRef.current -= targetLength;
      const payload = int16ToBase64(chunk);
      socketRef.current?.emit("input_audio", { data: payload });
    }
  }, []);

  const schedulePlayback = useCallback(
    async (base64: string) => {
      if (!base64) return;
      const audioCtx = await ensureAudioContext();
      const buf = base64ToArrayBuffer(base64);
      const view = new DataView(buf);
      const frames = view.byteLength / 2;

      const audioBuffer = audioCtx.createBuffer(1, frames, SAMPLE_RATE);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        channel[i] = view.getInt16(i * 2, true) / 32768;
      }

      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioCtx.destination);
      src.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(
          (node) => node !== src
        );
      };

      activeSourcesRef.current.push(src);

      if (playheadTimeRef.current < audioCtx.currentTime + 0.01) {
        playheadTimeRef.current = audioCtx.currentTime + 0.01;
      }

      src.start(playheadTimeRef.current);
      playheadTimeRef.current += audioBuffer.duration;
    },
    [ensureAudioContext]
  );

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
      cleanupInput();
      stopOutputPlayback();
    });

    socket.on("new_conversation", ({ data }) => {
      const nextConversation = data?.conversationId ?? null;
      if (!nextConversation) {
        conversationIdRef.current = null;
        setConversationId(null);
        setStatusMessage("Awaiting conversation id");
        stopOutputPlayback();
        return;
      }

      conversationIdRef.current = nextConversation;
      setConversationId(nextConversation);
      setStatusMessage(
        nextConversation
          ? `New conversation: ${nextConversation}`
          : "Awaiting conversation"
      );
      stopOutputPlayback();
    });

    socket.on("ready", () => {
      setStatusMessage("Session ready");
    });

    socket.on("processing_error", (payload) => {
      setStatusMessage(payload?.message || "Processing error");
    });

    socket.on("audio_start", async (payload) => {
      // const incomingConversationId = getConversationId(payload);
      // if (
      //   !incomingConversationId ||
      //   incomingConversationId !== conversationIdRef.current
      // ) {
      //   return;
      // }
      // const audioCtx = await ensureAudioContext();
      // stopOutputPlayback();
      // playheadTimeRef.current = audioCtx.currentTime;
      // setStatusMessage("Playing response");
    });

    socket.on("audio", ({ data }) => {
      const incomingConversationId = getConversationId(data);
      if (
        !incomingConversationId ||
        incomingConversationId !== conversationIdRef.current
      ) {
        return;
      }
      void schedulePlayback(data.audio);
    });

    socket.on("audio_end", (payload) => {
      // const incomingConversationId = getConversationId(payload);
      // if (
      //   !incomingConversationId ||
      //   incomingConversationId !== conversationIdRef.current
      // ) {
      //   return;
      // }
      // stopOutputPlayback();
      setStatusMessage("Output finished");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      cleanupInput();
      stopOutputPlayback();
      void resetAudioContext();
    };
  }, [
    cleanupInput,
    ensureAudioContext,
    resetAudioContext,
    schedulePlayback,
    stopOutputPlayback,
  ]);

  const startHoldingToTalk = useCallback(async () => {
    if (isHolding) return;
    if (!socketRef.current || !socketConnected) {
      setStatusMessage("Socket not connected");
      return;
    }

    try {
      const audioCtx = await ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      sourceNodeRef.current = source;
      processorNodeRef.current = processor;

      pendingSegmentsRef.current = [];
      pendingSamplesRef.current = 0;
      isSendingInputRef.current = true;

      processor.onaudioprocess = (event) => {
        if (!isSendingInputRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const down = downsample(input, audioCtx.sampleRate, SAMPLE_RATE);
        const pcm16 = floatTo16BitPCM(down);
        pendingSegmentsRef.current.push(pcm16);
        pendingSamplesRef.current += pcm16.length;
        drainInputChunks(false);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      socketRef.current.emit("start_stream");
      setIsHolding(true);
      setStatusMessage("Streaming microphone audio");
    } catch (err) {
      console.error("Microphone unavailable", err);
      setStatusMessage("Microphone unavailable");
      cleanupInput();
    }
  }, [
    cleanupInput,
    drainInputChunks,
    ensureAudioContext,
    isHolding,
    socketConnected,
  ]);

  const stopHoldingToTalk = useCallback(() => {
    if (!isHolding) return;
    isSendingInputRef.current = false;
    drainInputChunks(true);
    socketRef.current?.emit("end_stream");
    setStatusMessage("Stream ended");
    cleanupInput();
  }, [cleanupInput, drainInputChunks, isHolding]);

  const resetStream = useCallback(async () => {
    cleanupInput();
    stopOutputPlayback();
    setConversationId(null);
    conversationIdRef.current = null;
    setStatusMessage("Reset");
    socketRef.current?.emit("reset_session");
    await resetAudioContext();
  }, [cleanupInput, resetAudioContext, stopOutputPlayback]);

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
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                startHoldingToTalk();
              }}
              onPointerUp={(e) => {
                e.preventDefault();
                stopHoldingToTalk();
                e.currentTarget.releasePointerCapture?.(e.pointerId);
              }}
              onPointerCancel={(e) => {
                e.preventDefault();
                stopHoldingToTalk();
                e.currentTarget.releasePointerCapture?.(e.pointerId);
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
