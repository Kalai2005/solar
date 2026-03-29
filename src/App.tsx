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
  Upload
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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
  return viteEnv.VITE_GEMINI_API_KEY || viteEnv.GEMINI_API_KEY;
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
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
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
};

// --- Components ---

export default function App() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<(AnalysisResult & { image: string })[]>(() => {
    const saved = localStorage.getItem("solarguard_history");
    return saved ? JSON.parse(saved) : [];
  });
  const [view, setView] = useState<"camera" | "history">("camera");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Persistence
  useEffect(() => {
    localStorage.setItem("solarguard_history", JSON.stringify(history));
  }, [history]);

  // Initialize Camera
  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setError(null);
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Unable to access camera. Please ensure permissions are granted.");
    }
  };

  useEffect(() => {
    if (view === "camera") {
      startCamera();
    }
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [view]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg");
        setCapturedImage(dataUrl);
        // Stop stream to save battery
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          setStream(null);
        }
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setCapturedImage(reader.result as string);
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          setStream(null);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const resetCapture = () => {
    setCapturedImage(null);
    setResult(null);
    setError(null);
    startCamera();
  };

  const runAnalysis = async () => {
    if (!capturedImage) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const analysis = await analyzePanel(capturedImage);
      const resultWithTime = { 
        ...analysis, 
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleTimeString() 
      };
      setResult(resultWithTime);
      setHistory((prev) => [{ ...resultWithTime, image: capturedImage }, ...prev]);
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

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const clearAllHistory = () => {
    setHistory([]);
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
            {/* Camera Viewport */}
            <div className="relative aspect-[4/3] bg-black rounded-3xl overflow-hidden shadow-2xl border-4 border-white">
              {!capturedImage ? (
                <>
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-cover"
                  />
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
                    <div className="w-14 h-14" /> {/* Spacer */}
                  </div>
                </>
              ) : (
                <div className="relative w-full h-full">
                  <img src={capturedImage} className="w-full h-full object-cover" alt="Captured panel" />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    {!isAnalyzing && !result && (
                      <div className="flex flex-col items-center gap-4">
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
                          className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`p-2 rounded-xl ${getSeverityColor(defect.severity)}`}>
                                {defect.type === "crack" && <ShieldAlert className="w-5 h-5" />}
                                {defect.type === "dust" && <Wind className="w-5 h-5" />}
                                {defect.type === "hotspot" && <Zap className="w-5 h-5" />}
                                {defect.type === "shading" && <Sun className="w-5 h-5" />}
                                {defect.type === "bird_dropping" && <Droplets className="w-5 h-5" />}
                                {defect.type === "corrosion" && <Droplets className="w-5 h-5" />}
                                {defect.type === "none" && <CheckCircle2 className="w-5 h-5" />}
                              </div>
                              <span className="font-bold capitalize">{defect.type.replace("_", " ")}</span>
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
                    className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex gap-4 items-center group relative"
                  >
                    <img src={item.image} className="w-24 h-24 rounded-2xl object-cover shrink-0" alt="History" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-gray-400">{item.timestamp}</span>
                        <span className={`text-lg font-black ${getHealthColor(item.panel_health_score)}`}>{item.panel_health_score}%</span>
                      </div>
                      <p className="text-sm font-bold truncate">{item.summary}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {item.defects.length} {item.defects.length === 1 ? "defect" : "defects"} identified
                      </p>
                    </div>
                    <button 
                      onClick={() => deleteHistoryItem(item.id)}
                      className="p-2 text-gray-300 hover:text-red-500 transition-colors"
                      title="Delete entry"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
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
