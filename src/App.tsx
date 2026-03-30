/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Camera, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Zap, 
  Sun, 
  History, 
  Info,
  ShieldAlert,
  Droplets,
  Wind,
  Image as ImageIcon,
  Trash2,
  Upload,
  QrCode,
  Smartphone,
  Link as LinkIcon,
  Copy,
  Check
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import QRCode from "qrcode";

// --- Types ---

interface Defect {
  type: "crack" | "dust" | "hotspot" | "shading" | "bird_dropping" | "corrosion" | "none";
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  description: string;
  recommendation: string;
  location_on_panel?: string;
}

interface AnalysisResult {
  id: string;
  panel_health_score: number; // 0-100
  defects: Defect[];
  summary: string;
  timestamp: string;
}

// --- Gemini Service ---

const getGeminiApiKey = () => {
  const viteEnv = import.meta.env as Record<string, string | undefined>;
  const processEnv =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : {};

  const candidates = [
    viteEnv.VITE_GEMINI_API_KEY,
    viteEnv.GEMINI_API_KEY,
    processEnv.VITE_GEMINI_API_KEY,
    processEnv.GEMINI_API_KEY,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.trim();
    if (!normalized || normalized.toLowerCase() === "undefined") continue;
    return normalized;
  }

  return undefined;
};

const getPreferredGeminiModels = () => {
  const viteEnv = import.meta.env as Record<string, string | undefined>;
  const customModel = viteEnv.VITE_GEMINI_MODEL || viteEnv.GEMINI_MODEL;

  // Prefer user-specified model, then try stable/fast options before preview.
  return [
    customModel,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-3-flash-preview",
  ].filter((model): model is string => Boolean(model));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RESULT_CACHE_KEY = "solarguard_result_cache_v1";
const RELAY_POLL_MS = 2200;

const createRelaySessionId = () => crypto.randomUUID().split("-")[0];

const getImageFingerprint = (base64Image: string) => {
  const imageData = base64Image.split(",")[1] || base64Image;
  let hash = 0;
  for (let i = 0; i < imageData.length; i++) {
    hash = (hash * 31 + imageData.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const readResultCache = (): Record<string, AnalysisResult> => {
  try {
    const raw = localStorage.getItem(RESULT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, AnalysisResult>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeResultCache = (cache: Record<string, AnalysisResult>) => {
  localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(cache));
};

const isTransientGeminiError = (err: unknown) => {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("resource_exhausted") ||
    message.includes("overloaded")
  );
};

const getCameraAccessErrorMessage = (err: unknown) => {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return "Camera permission was blocked. Allow camera access in your browser settings and reload this page.";
    }

    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      return "No compatible camera was found on this phone. Try switching browser or use photo upload.";
    }

    if (err.name === "NotReadableError") {
      return "Camera is being used by another app. Close other camera apps and try again.";
    }
  }

  return "Unable to access camera. Please ensure permissions are granted.";
};

const analyzePanel = async (base64Image: string): Promise<AnalysisResult> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Missing API key. Add GEMINI_API_KEY or VITE_GEMINI_API_KEY to your .env.local file.");
  }
  if (apiKey.includes("PASTE_YOUR_REAL_GEMINI_API_KEY_HERE")) {
    throw new Error("Placeholder API key detected. Replace it in .env.local with your real Gemini API key.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelsToTry = getPreferredGeminiModels();
  let lastError: unknown = null;

  for (const model of modelsToTry) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image.split(",")[1],
                },
              },
              {
                text: `You are a professional solar panel inspection expert. Analyze this image of a solar panel for defects.
                Identify: Cracks (micro or macro), Dust/Soiling, Hotspots (if visible or inferred), Shading (from trees/structures), Bird droppings, or Corrosion.
                
                Return a JSON object with the following structure:
                {
                  "panel_health_score": number (0-100, where 100 is perfect),
                  "defects": [
                    {
                      "type": "crack" | "dust" | "hotspot" | "shading" | "bird_dropping" | "corrosion" | "none",
                      "severity": "low" | "medium" | "high" | "critical",
                      "confidence": number (0-1),
                      "description": "Short description of the defect",
                      "recommendation": "What should the maintenance team do?",
                      "location_on_panel": "e.g., Top left corner, center, etc."
                    }
                  ],
                  "summary": "A brief overall summary of the panel condition"
                }
                If no defects are found, return an empty defects array and a high health score.`,
              },
            ],
          },
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                panel_health_score: { type: Type.NUMBER },
                summary: { type: Type.STRING },
                defects: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      type: { type: Type.STRING },
                      severity: { type: Type.STRING },
                      confidence: { type: Type.NUMBER },
                      description: { type: Type.STRING },
                      recommendation: { type: Type.STRING },
                      location_on_panel: { type: Type.STRING },
                    },
                    required: ["type", "severity", "confidence", "description", "recommendation"],
                  },
                },
              },
              required: ["panel_health_score", "defects", "summary"],
            },
          },
        });

        return JSON.parse(response.text || "{}") as AnalysisResult;
      } catch (err) {
        lastError = err;
        const canRetry = isTransientGeminiError(err) && attempt < maxAttempts;
        if (canRetry) {
          const backoffMs = 600 * 2 ** (attempt - 1);
          await sleep(backoffMs);
          continue;
        }

        // Move to the next fallback model on transient outages.
        if (isTransientGeminiError(err)) {
          break;
        }

        throw err;
      }
    }
  }

  if (lastError instanceof Error && isTransientGeminiError(lastError)) {
    throw new Error(
      "Gemini is temporarily overloaded (503 high demand). Please try again in a few seconds."
    );
  }

  throw lastError instanceof Error ? lastError : new Error("Analysis failed unexpectedly.");
};

// --- Components ---

export default function App() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<(AnalysisResult & { image: string })[]>(() => {
    const saved = localStorage.getItem("solarguard_history");
    return saved ? JSON.parse(saved) : [];
  });
  const [view, setView] = useState<"camera" | "history">("camera");
  const [mobileAccessUrl, setMobileAccessUrl] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [copiedMobileUrl, setCopiedMobileUrl] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [relayNotice, setRelayNotice] = useState<string>("");
  const [isSendingToRelay, setIsSendingToRelay] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const relaySessionIdRef = useRef<string>(createRelaySessionId());
  const streamRef = useRef<MediaStream | null>(null);

  const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const isSecureCameraContext = window.isSecureContext || isLocalhost;
  const suggestedHttpsUrl =
    window.location.protocol === "http:"
      ? `https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
      : "";
  const trimmedMobileAccessUrl = mobileAccessUrl.trim();
  const hasMobileAccessUrl = Boolean(trimmedMobileAccessUrl);
  const isHttpMobileAccessUrl = /^http:\/\//i.test(trimmedMobileAccessUrl);
  const isHttpsMobileAccessUrl = /^https:\/\//i.test(trimmedMobileAccessUrl);
  const searchParams = new URLSearchParams(window.location.search);
  const relaySessionFromUrl = (searchParams.get("session") || "").trim();
  const isMobileRelayClient = isMobileDevice && searchParams.get("mobile") === "1" && Boolean(relaySessionFromUrl);

  // Persistence
  useEffect(() => {
    localStorage.setItem("solarguard_history", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    if (!isMobileDevice) {
      const relaySessionId = relaySessionIdRef.current;
      const relayUrl = `${baseUrl}?mobile=1&session=${relaySessionId}`;
      setMobileAccessUrl(relayUrl);
      setRelayNotice("Waiting for a photo from your phone...");
      return;
    }

    setMobileAccessUrl(baseUrl);
    if (isMobileRelayClient) {
      setRelayNotice("Connected to desktop SolarGuard session. Capture and send a photo.");
    }
  }, [isMobileDevice, isMobileRelayClient]);

  useEffect(() => {
    let isMounted = true;

    const buildQrCode = async () => {
      const trimmedUrl = mobileAccessUrl.trim();
      if (!trimmedUrl) {
        setQrCodeDataUrl(null);
        return;
      }

      try {
        const qrDataUrl = await QRCode.toDataURL(trimmedUrl, {
          width: 240,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        if (isMounted) {
          setQrCodeDataUrl(qrDataUrl);
        }
      } catch {
        if (isMounted) {
          setQrCodeDataUrl(null);
        }
      }
    };

    buildQrCode();

    return () => {
      isMounted = false;
    };
  }, [mobileAccessUrl]);

  const stopCameraStream = useCallback(() => {
    const current = streamRef.current;
    if (!current) return;

    current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  // Initialize camera once per scan session and reuse the same stream.
  const startCamera = useCallback(async () => {
    if (!isMobileDevice) {
      setError(null);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera is not supported in this browser.");
      return;
    }

    if (!isSecureCameraContext) {
      setError("Mobile camera requires HTTPS (or localhost). Open SolarGuard using https:// or your local localhost URL.");
      return;
    }

    const existing = streamRef.current;
    if (existing && existing.active) {
      if (videoRef.current && videoRef.current.srcObject !== existing) {
        videoRef.current.srcObject = existing;
      }
      return;
    }

    try {
      let mediaStream: MediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        // Fallback for devices/browsers that reject facingMode constraints.
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      streamRef.current = mediaStream;
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        try {
          await videoRef.current.play();
        } catch {
          // Some mobile browsers defer autoplay until the user taps Start Camera.
        }
      }
      setError(null);
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError(getCameraAccessErrorMessage(err));
    }
  }, [isMobileDevice, isSecureCameraContext]);

  useEffect(() => {
    const shouldRunCamera = isMobileDevice && view === "camera" && !capturedImage;

    if (shouldRunCamera) {
      void startCamera();
    } else {
      stopCameraStream();
    }

    return () => {
      stopCameraStream();
    };
  }, [capturedImage, isMobileDevice, startCamera, stopCameraStream, view]);

  // Ensure an already-started stream is attached once the video element mounts.
  useEffect(() => {
    if (!stream || !videoRef.current) return;

    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }

    void videoRef.current.play().catch(() => {
      // Some browsers require user interaction before playback starts.
    });
  }, [stream]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video.videoWidth || !video.videoHeight) {
        setError("Camera is not ready yet. Please wait a moment and try again.");
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg");
        setCapturedImage(dataUrl);
        // Stop stream to save battery
        stopCameraStream();
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFileName(file.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        setCapturedImage(reader.result as string);
        stopCameraStream();
      };
      reader.readAsDataURL(file);
    }
  };

  const resetCapture = () => {
    setCapturedImage(null);
    setResult(null);
    setError(null);
    setUploadedFileName(null);
    if (isMobileDevice) {
      void startCamera();
    }
  };

  const runAnalysis = async () => {
    if (!capturedImage) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const imageKey = getImageFingerprint(capturedImage);
      const cached = readResultCache()[imageKey];
      if (cached) {
        setResult(cached);
        setHistory((prev) => [{ ...cached, image: capturedImage }, ...prev]);
        setRelayNotice("Analysis complete.");
        return;
      }

      const analysis = await analyzePanel(capturedImage);
      const resultWithTime = { 
        ...analysis, 
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleTimeString() 
      };

      const cache = readResultCache();
      cache[imageKey] = resultWithTime;
      writeResultCache(cache);

      setResult(resultWithTime);
      setHistory((prev) => [{ ...resultWithTime, image: capturedImage }, ...prev]);
      setRelayNotice("Analysis complete.");
    } catch (err) {
      console.error("Analysis failed:", err);
      if (err instanceof Error) {
        if (err.message.toLowerCase().includes("api key not valid")) {
          setError("Your Gemini API key is invalid. Update .env.local with a valid key, then restart npm run dev.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Analysis failed. Please try again with a clearer image.");
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const analyzeCapturedImage = useCallback(async (image: string) => {
    setIsAnalyzing(true);
    setError(null);
    try {
      const imageKey = getImageFingerprint(image);
      const cached = readResultCache()[imageKey];
      if (cached) {
        setResult(cached);
        setHistory((prev) => [{ ...cached, image }, ...prev]);
        setRelayNotice("Analysis complete.");
        return;
      }

      const analysis = await analyzePanel(image);
      const resultWithTime = { 
        ...analysis, 
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleTimeString() 
      };

      const cache = readResultCache();
      cache[imageKey] = resultWithTime;
      writeResultCache(cache);

      setResult(resultWithTime);
      setHistory((prev) => [{ ...resultWithTime, image }, ...prev]);
      setRelayNotice("Analysis complete.");
    } catch (err) {
      console.error("Analysis failed:", err);
      if (err instanceof Error) {
        if (err.message.toLowerCase().includes("api key not valid")) {
          setError("Your Gemini API key is invalid. Update .env.local with a valid key, then restart npm run dev.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Analysis failed. Please try again with a clearer image.");
      }
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  useEffect(() => {
    if (isMobileDevice || !relaySessionIdRef.current) return;

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/relay/${relaySessionIdRef.current}?take=1`);
        if (!response.ok) return;
        const payload = (await response.json()) as { image?: string | null };
        if (!payload.image) return;

        setCapturedImage(payload.image);
        setUploadedFileName("Photo from mobile session");
        setResult(null);
        setRelayNotice("Photo received. Running analysis...");
        await analyzeCapturedImage(payload.image);
      } catch {
        // Keep polling; intermittent fetch failures are expected on local networks.
      }
    }, RELAY_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [analyzeCapturedImage, isMobileDevice]);

  const sendCaptureToRelay = async () => {
    if (!capturedImage || !relaySessionFromUrl) return;

    setIsSendingToRelay(true);
    setError(null);

    try {
      const response = await fetch(`/api/relay/${relaySessionFromUrl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image: capturedImage }),
      });

      if (!response.ok) {
        throw new Error("Failed to send photo to SolarGuard relay.");
      }

      setRelayNotice("Photo sent to desktop SolarGuard. Check your computer for results.");
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Could not send photo to SolarGuard relay.");
      }
    } finally {
      setIsSendingToRelay(false);
    }
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const clearAllHistory = () => {
    setHistory([]);
    setExpandedHistoryId(null);
  };

  const copyMobileUrl = async () => {
    if (!trimmedMobileAccessUrl) return;
    try {
      await navigator.clipboard.writeText(trimmedMobileAccessUrl);
      setCopiedMobileUrl(true);
      window.setTimeout(() => setCopiedMobileUrl(false), 1600);
    } catch {
      setError("Could not copy the mobile URL. Please copy it manually.");
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "text-red-500 bg-red-50 border-red-200";
      case "high": return "text-orange-500 bg-orange-50 border-orange-200";
      case "medium": return "text-yellow-600 bg-yellow-50 border-yellow-200";
      case "low": return "text-blue-500 bg-blue-50 border-blue-200";
      default: return "text-gray-500 bg-gray-50 border-gray-200";
    }
  };

  const getHealthColor = (score: number) => {
    if (score >= 90) return "text-emerald-500";
    if (score >= 70) return "text-yellow-500";
    if (score >= 40) return "text-orange-500";
    return "text-red-500";
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-emerald-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-200">
            <Zap className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">SolarGuard</h1>
            <p className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold">Defect Detection System</p>
          </div>
        </div>
        <nav className="flex bg-gray-100 p-1 rounded-lg">
          <button 
            onClick={() => setView("camera")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${view === "camera" ? "bg-white shadow-sm text-emerald-600" : "text-gray-500 hover:text-gray-700"}`}
          >
            Scanner
          </button>
          <button 
            onClick={() => setView("history")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${view === "history" ? "bg-white shadow-sm text-emerald-600" : "text-gray-500 hover:text-gray-700"}`}
          >
            History
          </button>
        </nav>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        {view === "camera" ? (
          <div className="space-y-6">
            {!isMobileDevice && (
              <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                    <QrCode className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Open Camera On Mobile</h2>
                    <p className="text-xs text-gray-500">Scan this QR code on your phone to open SolarGuard and capture a photo there.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 items-center">
                  <div className="w-[180px] h-[180px] rounded-2xl border border-gray-200 bg-gray-50 flex items-center justify-center overflow-hidden">
                    {qrCodeDataUrl ? (
                      <img src={qrCodeDataUrl} alt="Mobile access QR code" className="w-full h-full object-cover" />
                    ) : (
                      <div className="text-xs text-gray-400 text-center px-4">Enter a valid URL to generate QR code</div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                      <LinkIcon className="w-3.5 h-3.5" />
                      Mobile Access URL
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="url"
                        value={mobileAccessUrl}
                        onChange={(e) => setMobileAccessUrl(e.target.value)}
                        placeholder="https://192.168.1.10:3001"
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-400"
                      />
                      <button
                        onClick={copyMobileUrl}
                        disabled={!hasMobileAccessUrl}
                        className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-900 text-white hover:bg-black transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {copiedMobileUrl ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedMobileUrl ? "Copied" : "Copy URL"}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">1. Copy URL</span>
                      <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">2. Open on phone</span>
                      <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">3. Capture photo</span>
                    </div>
                    {hasMobileAccessUrl && isHttpMobileAccessUrl && (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                        HTTP link detected. On many phones, camera access works best over HTTPS.
                      </p>
                    )}
                    {hasMobileAccessUrl && isHttpsMobileAccessUrl && (
                      <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
                        Secure HTTPS link ready for phone camera access.
                      </p>
                    )}
                    <p className="text-xs text-gray-500 flex items-start gap-1.5">
                      <Smartphone className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      {isLocalhost
                        ? "Use your network URL (example: https://192.168.x.x:3001) so your phone can reach this app."
                        : "Keep your phone and computer on the same Wi-Fi network for the fastest camera handoff."}
                    </p>
                    <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
                      {relayNotice}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {isMobileRelayClient && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 text-xs text-emerald-800">
                {relayNotice}
              </div>
            )}

            {isMobileDevice && !isSecureCameraContext && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs text-amber-900 space-y-2">
                <p className="font-semibold">Phone camera is blocked on non-HTTPS pages.</p>
                <p>Open this secure URL on your phone and accept the certificate warning once:</p>
                {suggestedHttpsUrl && (
                  <a
                    href={suggestedHttpsUrl}
                    className="text-amber-700 underline break-all"
                  >
                    {suggestedHttpsUrl}
                  </a>
                )}
              </div>
            )}

            <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-3">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-bold text-gray-900">Upload Photo</h3>
              </div>
              <p className="text-xs text-gray-500">
                Select a solar panel photo from your device and run analysis.
              </p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer">
                  Choose Photo
                  <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                </label>
                <p className="text-xs text-gray-500 truncate">
                  {uploadedFileName ? `Selected: ${uploadedFileName}` : "No photo selected yet"}
                </p>
              </div>
            </div>

            {/* Camera Viewport */}
            <div className="relative aspect-[4/3] bg-black rounded-3xl overflow-hidden shadow-2xl border-4 border-white">
              {!capturedImage ? (
                <>
                  {!isMobileDevice ? (
                    <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-8">
                      <div className="max-w-md text-center text-white space-y-3">
                        <Smartphone className="w-12 h-12 mx-auto text-emerald-400" />
                        <h3 className="text-xl font-bold">Desktop Camera Disabled</h3>
                        <p className="text-sm text-gray-200">
                          Camera turns on automatically on mobile phone. Scan the QR code above and capture from your phone.
                        </p>
                      </div>
                    </div>
                  ) : stream ? (
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-8">
                      <div className="max-w-md text-center text-white space-y-3">
                        <Camera className="w-12 h-12 mx-auto text-emerald-400" />
                        <h3 className="text-xl font-bold">Starting Mobile Camera</h3>
                        <p className="text-sm text-gray-200">
                          Allow camera permission when prompted. SolarGuard will open your phone camera automatically.
                        </p>
                        <button
                          onClick={startCamera}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500 text-white font-semibold hover:bg-emerald-600 transition-colors"
                        >
                          <Camera className="w-4 h-4" />
                          Start Camera
                        </button>
                      </div>
                    </div>
                  )}

                  {isMobileDevice && stream && (
                    <>
                      {/* Overlay UI */}
                      <div className="absolute inset-0 pointer-events-none flex flex-center items-center justify-center">
                        <div className="w-64 h-64 border-2 border-white/30 rounded-2xl relative">
                          <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-emerald-500 rounded-tl-lg"></div>
                          <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-emerald-500 rounded-tr-lg"></div>
                          <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-emerald-500 rounded-bl-lg"></div>
                          <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-emerald-500 rounded-br-lg"></div>
                        </div>
                      </div>
                      <div className="absolute bottom-8 left-0 right-0 flex justify-center items-center gap-6 px-8">
                        <label className="p-4 bg-white rounded-full text-emerald-700 border-2 border-emerald-200 shadow-lg cursor-pointer hover:bg-emerald-600 hover:text-white transition-colors">
                          <Upload className="w-6 h-6" />
                          <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                        </label>
                        <button
                          onClick={capturePhoto}
                          className="w-20 h-20 bg-white rounded-full flex items-center justify-center border-8 border-emerald-500/30 hover:scale-105 active:scale-95 transition-all"
                        >
                          <div className="w-14 h-14 bg-emerald-500 rounded-full flex items-center justify-center">
                            <Camera className="text-white w-8 h-8" />
                          </div>
                        </button>
                        <div className="w-14 h-14" />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="relative w-full h-full">
                  <img src={capturedImage} className="w-full h-full object-cover" alt="Captured panel" />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    {!isAnalyzing && !result && (
                      <div className="flex flex-col items-center gap-4">
                        {isMobileRelayClient && (
                          <button
                            onClick={sendCaptureToRelay}
                            disabled={isSendingToRelay}
                            className="px-8 py-3 bg-gray-900 text-white rounded-2xl font-bold hover:bg-black transition-all disabled:opacity-70"
                          >
                            {isSendingToRelay ? "Sending Photo..." : "Send to SolarGuard"}
                          </button>
                        )}
                        <button 
                          onClick={runAnalysis}
                          className="px-8 py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-xl shadow-emerald-500/20 hover:bg-emerald-600 transition-all flex items-center gap-2"
                        >
                          <Zap className="w-5 h-5 fill-current" />
                          Analyze Panel
                        </button>
                        <button 
                          onClick={resetCapture}
                          className="text-white/80 text-sm font-medium hover:text-white flex items-center gap-1"
                        >
                          <RefreshCw className="w-4 h-4" />
                          Retake Photo
                        </button>
                      </div>
                    )}
                    {isAnalyzing && (
                      <div className="flex flex-col items-center gap-4 text-white">
                        <div className="w-16 h-16 border-4 border-white/20 border-t-emerald-500 rounded-full animate-spin"></div>
                        <p className="font-medium tracking-wide animate-pulse">AI Analysis in progress...</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <canvas ref={canvasRef} className="hidden" />
            </div>

            {/* Error Message */}
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3 text-red-600"
              >
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm font-medium">{error}</p>
              </motion.div>
            )}

            {/* Analysis Results */}
            <AnimatePresence>
              {result && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-6"
                >
                  {/* Summary Card */}
                  <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
                    <div className="flex items-start justify-between mb-6">
                      <div className="space-y-1">
                        <h2 className="text-xl font-bold">Inspection Report</h2>
                        <p className="text-sm text-gray-500 flex items-center gap-1">
                          <History className="w-3 h-3" />
                          Generated at {result.timestamp}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className={`text-4xl font-black ${getHealthColor(result.panel_health_score)}`}>
                          {result.panel_health_score}%
                        </div>
                        <p className="text-[10px] uppercase font-bold tracking-widest text-gray-400">Health Score</p>
                      </div>
                    </div>
                    <p className="text-gray-700 leading-relaxed bg-gray-50 p-4 rounded-2xl border border-gray-100 italic">
                      "{result.summary}"
                    </p>
                  </div>

                  {/* Defects List */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {result.defects.length > 0 ? (
                      result.defects.map((defect, idx) => (
                        <motion.div 
                          key={idx}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: idx * 0.1 }}
                          className={`bg-white rounded-3xl border border-gray-100 shadow-sm space-y-4 ${defect.type === "crack" ? "p-6 md:col-span-2" : "p-5"}`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`${defect.type === "crack" ? "p-3 rounded-2xl" : "p-2 rounded-xl"} ${getSeverityColor(defect.severity)}`}>
                                {defect.type === "crack" && <ShieldAlert className="w-6 h-6" />}
                                {defect.type === "dust" && <Wind className="w-5 h-5" />}
                                {defect.type === "hotspot" && <Zap className="w-5 h-5" />}
                                {defect.type === "shading" && <Sun className="w-5 h-5" />}
                                {defect.type === "bird_dropping" && <Droplets className="w-5 h-5" />}
                                {defect.type === "corrosion" && <Droplets className="w-5 h-5" />}
                                {defect.type === "none" && <CheckCircle2 className="w-5 h-5" />}
                              </div>
                              <span className={`${defect.type === "crack" ? "text-lg" : ""} font-bold capitalize`}>{defect.type.replace("_", " ")}</span>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${getSeverityColor(defect.severity)}`}>
                              {defect.severity}
                            </span>
                          </div>
                          <div className="space-y-2">
                            <p className="text-sm text-gray-600">{defect.description}</p>
                            <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                              <p className="text-xs font-semibold text-emerald-800 flex items-center gap-1.5">
                                <Info className="w-3.5 h-3.5" />
                                Recommendation
                              </p>
                              <p className="text-xs text-emerald-700 mt-1">{defect.recommendation}</p>
                            </div>
                          </div>
                          {defect.location_on_panel && (
                            <div className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                              <ImageIcon className="w-3 h-3" />
                              Location: {defect.location_on_panel}
                            </div>
                          )}
                        </motion.div>
                      ))
                    ) : (
                      <div className="col-span-full bg-emerald-50 p-8 rounded-3xl border border-emerald-100 flex flex-col items-center text-center gap-3">
                        <CheckCircle2 className="w-12 h-12 text-emerald-500" />
                        <h3 className="font-bold text-emerald-900">No Defects Detected</h3>
                        <p className="text-sm text-emerald-700 max-w-xs">Your solar panel appears to be in optimal condition. Regular cleaning is still recommended.</p>
                      </div>
                    )}
                  </div>

                  <button 
                    onClick={resetCapture}
                    className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold hover:bg-black transition-all"
                  >
                    Start New Inspection
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-2xl font-bold">Inspection History</h2>
              {history.length > 0 && (
                <button 
                  onClick={clearAllHistory}
                  className="text-xs font-bold text-red-500 hover:text-red-600 flex items-center gap-1 bg-red-50 px-3 py-1.5 rounded-full transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear All
                </button>
              )}
            </div>
            {history.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {history.map((item, idx) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    key={item.id} 
                    className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm group relative"
                  >
                    <div className="flex gap-4 items-start">
                      <img src={item.image} className="w-24 h-24 rounded-2xl object-cover shrink-0" alt="History" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold text-gray-400">{item.timestamp}</span>
                          <span className={`text-lg font-black ${getHealthColor(item.panel_health_score)}`}>{item.panel_health_score}%</span>
                        </div>
                        <p className="text-sm font-bold truncate">{item.summary}</p>
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <p className="text-xs text-gray-500">
                            {item.defects.length} {item.defects.length === 1 ? "defect" : "defects"} identified
                          </p>
                          {item.defects.length > 0 ? (
                            item.defects.slice(0, 3).map((defect, defectIdx) => (
                              <span
                                key={`${item.id}-chip-${defectIdx}`}
                                className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${getSeverityColor(defect.severity)}`}
                              >
                                {defect.type.replace("_", " ")}
                              </span>
                            ))
                          ) : (
                            <span className="px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border text-emerald-700 bg-emerald-50 border-emerald-200">
                              no defects
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-1">
                        {item.defects.length > 0 && (
                          <button
                            onClick={() => setExpandedHistoryId(prev => (prev === item.id ? null : item.id))}
                            className="px-4 py-2 text-sm font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-full transition-colors"
                          >
                            {expandedHistoryId === item.id ? "Hide Problems" : "View Problems"}
                          </button>
                        )}
                        <button 
                          onClick={() => deleteHistoryItem(item.id)}
                          className="p-2 text-gray-300 hover:text-red-500 transition-colors"
                          title="Delete entry"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>

                    {expandedHistoryId === item.id && item.defects.length > 0 && (
                      <div className="mt-5 pt-5 border-t border-gray-100 space-y-4">
                        <p className="text-sm font-bold uppercase tracking-wider text-gray-500">Detected Problems</p>
                        {item.defects.map((defect, defectIdx) => (
                          <div key={`${item.id}-problem-${defectIdx}`} className="rounded-2xl border border-gray-100 bg-gray-50 p-4 md:p-5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-base font-bold capitalize text-gray-800">{defect.type.replace("_", " ")}</p>
                              <span className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide border ${getSeverityColor(defect.severity)}`}>
                                {defect.severity}
                              </span>
                            </div>
                            <p className="text-sm text-gray-600 mt-2.5">{defect.description}</p>
                            <p className="text-sm text-emerald-700 mt-2.5"><span className="font-semibold">Recommendation:</span> {defect.recommendation}</p>
                            {defect.location_on_panel && (
                              <p className="text-xs text-gray-500 mt-2.5">Location: {defect.location_on_panel}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="py-20 text-center space-y-4">
                <History className="w-16 h-16 text-gray-200 mx-auto" />
                <p className="text-gray-400 font-medium">No previous inspections found.</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer Info */}
      <footer className="max-w-4xl mx-auto p-6 text-center">
        <p className="text-[10px] text-gray-400 font-medium uppercase tracking-[0.2em]">
          Powered by Gemini Vision AI • SolarGuard v1.0
        </p>
      </footer>
    </div>
  );
}
