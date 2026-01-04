import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CHAR_LIMIT = 500;
const MAX_SELECTIONS = 10;
const STORAGE_KEY = 'ai_slide_restore_api_key';

type SelectionType = 'text' | 'image-ai' | 'image-replace';

interface SelectionArea {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: SelectionType;
  replacementImage?: string;
  imageRotation?: number;
  imageFlipX?: boolean;
  imageFlipY?: boolean;
  textColor?: string;
  textBgColor?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  textAlign?: 'left' | 'center' | 'right';
  fontFamily?: string;
  textRotation?: number;  // v3.5: 텍스트 회전
  autoFitWidth?: boolean; // v3.6: 영역 너비에 맞춤
}

interface Sticker {
  id: number;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipX: boolean;
  opacity: number;
  scale: number;
}

interface TextSegment {
  text: string;
  color: string;
  newLine?: boolean;  // v3.5: 이 세그먼트 앞에서 줄바꿈
}

interface CustomText {
  id: number;
  segments: TextSegment[];
  x: number;
  y: number;
  fontSize: number;
  scale: number;
  opacity: number;
  fontWeight: 'normal' | 'bold';
  rotation: number;
  fontFamily?: string;
}

interface HistoryState {
  selections: SelectionArea[];
  replacements: { [key: number]: string };
  stickers: Sticker[];
  customTexts: CustomText[];
}

const DEFAULT_COLORS = ['#ef4444', '#eab308', '#3b82f6'];

const FONT_OPTIONS = [
  { value: 'Noto Sans KR', label: '고딕 (Noto Sans KR)' },
  { value: 'Noto Serif KR', label: '명조 (Noto Serif KR)' },
  { value: 'Black Han Sans', label: '굵은 고딕 (Black Han Sans)' },
  { value: 'Jua', label: '둥근체 (Jua)' },
  { value: 'Do Hyeon', label: '돋움체 (Do Hyeon)' },
  { value: 'Nanum Gothic', label: '나눔고딕 (Nanum Gothic)' },
  { value: 'Nanum Myeongjo', label: '나눔명조 (Nanum Myeongjo)' },
];

// 색상 유틸리티 함수들
const rgbToHex = (r: number, g: number, b: number): string => {
  return '#' + [r, g, b].map(x => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('');
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

const getLuminance = (r: number, g: number, b: number): number => {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

function App() {
  const [image, setImage] = useState<string | null>(null);
  const [originalImageData, setOriginalImageData] = useState<ImageData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState<string>('');
  const [selections, setSelections] = useState<SelectionArea[]>([]);
  const [replacements, setReplacements] = useState<{ [key: number]: string }>({});
  const [resultImage, setResultImage] = useState<string | null>(null);
  
  const [drawMode, setDrawMode] = useState<SelectionType>('text');
  
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [customTexts, setCustomTexts] = useState<CustomText[]>([]);
  const [selectedId, setSelectedId] = useState<{id: number, type: 'sticker' | 'text' | 'selection'} | null>(null);

  const [isKeySelected, setIsKeySelected] = useState<boolean | null>(null);
  const [manualKey, setManualKey] = useState<string>('');
  const [showManualInput, setShowManualInput] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  const [eyedropperMode, setEyedropperMode] = useState<{active: boolean, selectionId: number | null, target: 'text' | 'bg'}>({active: false, selectionId: null, target: 'text'});

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPageNum, setCurrentPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);

  const [autoAnalyzeEnabled, setAutoAnalyzeEnabled] = useState(true);
  
  // v3.4: 실시간 미리보기 토글
  const [previewEnabled, setPreviewEnabled] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const isDrawing = useRef(false);
  const isMoving = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const stickerImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const replacementImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());

  useEffect(() => {
    // v3.5.5: 브라우저 탭 타이틀 설정
    document.title = '록신 이미지 에디터 v3.5.5';
    
    checkInitialKeyStatus();
    loadPdfLibrary();
    loadGoogleFonts();
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) {
      setManualKey(savedKey);
      setKeySaved(true);
    }
  }, []);

  const loadGoogleFonts = () => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&family=Noto+Serif+KR:wght@400;700&family=Black+Han+Sans&family=Jua&family=Do+Hyeon&family=Nanum+Gothic:wght@400;700&family=Nanum+Myeongjo:wght@400;700&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  };

  // =====================================================
  // 🚀 v3.2 핵심: 초고속 자동 분석 (OCR 없음!)
  // =====================================================
  const analyzeTextAreaFast = (x: number, y: number, w: number, h: number): { bgColor: string; textColor: string; fontSize: number } => {
    if (!originalCanvasRef.current) {
      return { bgColor: '#ffffff', textColor: '#000000', fontSize: Math.round(h * 0.7) };
    }

    const ctx = originalCanvasRef.current.getContext('2d')!;
    const canvasWidth = originalCanvasRef.current.width;
    const canvasHeight = originalCanvasRef.current.height;

    // 안전한 좌표 계산
    const safeX = Math.max(0, Math.min(Math.round(x), canvasWidth - 1));
    const safeY = Math.max(0, Math.min(Math.round(y), canvasHeight - 1));
    const safeW = Math.min(Math.round(w), canvasWidth - safeX);
    const safeH = Math.min(Math.round(h), canvasHeight - safeY);

    if (safeW <= 0 || safeH <= 0) {
      return { bgColor: '#ffffff', textColor: '#000000', fontSize: Math.round(h * 0.7) };
    }

    // 1. 배경색 감지: 가장자리 픽셀 샘플링 (매우 빠름)
    const bgColor = detectBackgroundColorFast(ctx, safeX, safeY, safeW, safeH);
    
    // 2. 글자색 감지: 배경과 대비되는 색상 찾기
    const textColor = detectTextColorFast(ctx, safeX, safeY, safeW, safeH, bgColor);
    
    // 3. 글자 크기: 영역 높이 기반 추정 (즉시)
    const fontSize = Math.round(safeH * 0.7);

    return { bgColor, textColor, fontSize: Math.max(12, Math.min(200, fontSize)) };
  };

  // 초고속 배경색 감지: 가장자리 픽셀만 샘플링
  const detectBackgroundColorFast = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string => {
    const samples: number[][] = [];
    
    // 4개 모서리 + 4개 변의 중간점 = 8개 포인트만 샘플링
    const points = [
      [x + 2, y + 2],           // 좌상
      [x + w - 2, y + 2],       // 우상
      [x + 2, y + h - 2],       // 좌하
      [x + w - 2, y + h - 2],   // 우하
      [x + w/2, y + 2],         // 상단 중앙
      [x + w/2, y + h - 2],     // 하단 중앙
      [x + 2, y + h/2],         // 좌측 중앙
      [x + w - 2, y + h/2],     // 우측 중앙
    ];

    points.forEach(([px, py]) => {
      try {
        const pixel = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
        samples.push([pixel[0], pixel[1], pixel[2]]);
      } catch (e) {}
    });

    if (samples.length === 0) return '#ffffff';

    // 평균색 계산
    const avgR = Math.round(samples.reduce((sum, p) => sum + p[0], 0) / samples.length);
    const avgG = Math.round(samples.reduce((sum, p) => sum + p[1], 0) / samples.length);
    const avgB = Math.round(samples.reduce((sum, p) => sum + p[2], 0) / samples.length);

    return rgbToHex(avgR, avgG, avgB);
  };

  // 초고속 글자색 감지: 중앙 영역 샘플링 후 배경과 대비
  const detectTextColorFast = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bgColor: string): string => {
    const bgRgb = hexToRgb(bgColor);
    if (!bgRgb) return '#000000';

    // 중앙 영역 샘플링
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const sampleRadius = Math.min(w, h) / 4;
    
    const samples: number[][] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const px = centerX + Math.cos(angle) * sampleRadius;
      const py = centerY + Math.sin(angle) * sampleRadius;
      try {
        const pixel = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
        samples.push([pixel[0], pixel[1], pixel[2]]);
      } catch (e) {}
    }

    // 배경과 가장 다른 색상 찾기
    let maxDiff = 0;
    let bestColor = '#000000';
    
    samples.forEach(([r, g, b]) => {
      const diff = Math.abs(r - bgRgb.r) + Math.abs(g - bgRgb.g) + Math.abs(b - bgRgb.b);
      if (diff > maxDiff) {
        maxDiff = diff;
        bestColor = rgbToHex(r, g, b);
      }
    });

    // 대비가 충분하지 않으면 배경 밝기에 따라 검정/흰색
    if (maxDiff < 100) {
      const bgLuminance = getLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
      return bgLuminance > 0.5 ? '#000000' : '#ffffff';
    }

    return bestColor;
  };

  // 주변 배경색 감지 (이미지 대체용)
  const detectSurroundingColor = (x: number, y: number, w: number, h: number): string => {
    if (!originalCanvasRef.current) return '#ffffff';
    
    const ctx = originalCanvasRef.current.getContext('2d')!;
    const canvasWidth = originalCanvasRef.current.width;
    const canvasHeight = originalCanvasRef.current.height;
    
    const samples: number[][] = [];
    const margin = 10;
    
    // 선택 영역 바깥의 픽셀 샘플링
    const points = [
      [x - margin, y + h/2],
      [x + w + margin, y + h/2],
      [x + w/2, y - margin],
      [x + w/2, y + h + margin],
    ];
    
    points.forEach(([px, py]) => {
      if (px >= 0 && px < canvasWidth && py >= 0 && py < canvasHeight) {
        try {
          const pixel = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
          samples.push([pixel[0], pixel[1], pixel[2]]);
        } catch (e) {}
      }
    });
    
    if (samples.length === 0) return '#ffffff';
    
    const avgR = Math.round(samples.reduce((sum, p) => sum + p[0], 0) / samples.length);
    const avgG = Math.round(samples.reduce((sum, p) => sum + p[1], 0) / samples.length);
    const avgB = Math.round(samples.reduce((sum, p) => sum + p[2], 0) / samples.length);
    
    return rgbToHex(avgR, avgG, avgB);
  };

  const checkInitialKeyStatus = async () => {
    if ((window as any).aistudio?.getSelectedApiKey) {
      try {
        const key = await (window as any).aistudio.getSelectedApiKey();
        setIsKeySelected(!!key);
      } catch {
        setIsKeySelected(false);
      }
    } else {
      const saved = localStorage.getItem(STORAGE_KEY);
      setIsKeySelected(!!saved);
    }
  };

  const loadPdfLibrary = () => {
    if ((window as any).pdfjsLib) return;
    const script = document.createElement('script');
    script.src = PDFJS_SRC;
    script.onload = () => {
      (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    };
    document.head.appendChild(script);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type === 'application/pdf') {
      loadPdf(file);
    } else {
      loadImage(file);
    }
  };

  const loadPdf = async (file: File) => {
    const pdfjsLib = (window as any).pdfjsLib;
    if (!pdfjsLib) {
      alert('PDF 라이브러리 로딩 중... 잠시 후 다시 시도해주세요.');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    setPdfDoc(pdf);
    setNumPages(pdf.numPages);
    setCurrentPageNum(1);
    renderPdfPage(pdf, 1);
  };

  const renderPdfPage = async (pdf: any, pageNum: number) => {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2 });

    const canvas = originalCanvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setOriginalImageData(imageData);
    setImage(canvas.toDataURL('image/png'));
    setResultImage(null);
    setSelections([]);
    setReplacements({});
    setStickers([]);
    setCustomTexts([]);
    setHistory([]);
    setHistoryIndex(-1);
  };

  const changePage = (delta: number) => {
    if (!pdfDoc) return;
    const newPageNum = currentPageNum + delta;
    if (newPageNum < 1 || newPageNum > numPages) return;
    setCurrentPageNum(newPageNum);
    renderPdfPage(pdfDoc, newPageNum);
  };

  const loadImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = originalCanvasRef.current!;
        const ctx = canvas.getContext('2d')!;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        setOriginalImageData(imageData);

        setImage(e.target!.result as string);
        setResultImage(null);
        setSelections([]);
        setReplacements({});
        setStickers([]);
        setCustomTexts([]);
        setPdfDoc(null);
        setNumPages(0);
        setCurrentPageNum(1);
        setHistory([]);
        setHistoryIndex(-1);
      };
      img.src = e.target!.result as string;
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (image && canvasRef.current) {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current!;
        canvas.width = img.width;
        canvas.height = img.height;
        redrawCanvas();
      };
      img.src = image;
    }
  }, [image]);

  useEffect(() => {
    redrawCanvas();
  }, [selections, stickers, customTexts, replacements, previewEnabled]);

  // v3.4: 줄바꿈 지원 텍스트 래핑
  const wrapTextWithNewlines = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
    // 먼저 Enter로 구분된 줄 처리
    const paragraphs = text.split('\n');
    const allLines: string[] = [];

    paragraphs.forEach((paragraph) => {
      if (paragraph === '') {
        allLines.push('');
        return;
      }

      // 각 문단을 maxWidth에 맞게 래핑
      const words = paragraph.split('');
      let currentLine = '';

      words.forEach((char) => {
        const testLine = currentLine + char;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && currentLine !== '') {
          allLines.push(currentLine);
          currentLine = char;
        } else {
          currentLine = testLine;
        }
      });

      if (currentLine) allLines.push(currentLine);
    });

    return allLines;
  };

  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;

    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      selections.forEach((sel) => {
        if (sel.type === 'image-replace' && sel.replacementImage) {
          const replImg = replacementImagesRef.current.get(sel.id);
          if (replImg && replImg.complete) {
            ctx.save();
            ctx.translate(sel.x + sel.w / 2, sel.y + sel.h / 2);
            if (sel.imageRotation) ctx.rotate((sel.imageRotation * Math.PI) / 180);
            const scaleX = sel.imageFlipX ? -1 : 1;
            const scaleY = sel.imageFlipY ? -1 : 1;
            ctx.scale(scaleX, scaleY);
            ctx.drawImage(replImg, -sel.w / 2, -sel.h / 2, sel.w, sel.h);
            ctx.restore();
          }
        }

        // v3.5: 실시간 텍스트 미리보기 (회전 지원)
        if (sel.type === 'text' && previewEnabled && replacements[sel.id]) {
          ctx.save();
          
          // 중심점으로 이동 후 회전
          const centerX = sel.x + sel.w / 2;
          const centerY = sel.y + sel.h / 2;
          ctx.translate(centerX, centerY);
          if (sel.textRotation) {
            ctx.rotate((sel.textRotation * Math.PI) / 180);
          }
          
          // 배경 채우기 (중심 기준)
          ctx.fillStyle = sel.textBgColor || '#ffffff';
          ctx.fillRect(-sel.w / 2, -sel.h / 2, sel.w, sel.h);
          
          // 텍스트 그리기
          const text = replacements[sel.id];
          ctx.fillStyle = sel.textColor || '#000000';
          ctx.font = `${sel.fontWeight || 'normal'} ${sel.fontSize || 32}px ${sel.fontFamily || 'Noto Sans KR'}`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = sel.textAlign || 'center';
          
          // v3.5.1: 패딩 최소화 (sel.w - 4)
          const lines = wrapTextWithNewlines(ctx, text, sel.w - 4);
          const lineHeight = (sel.fontSize || 32) * 1.2;
          const totalHeight = lines.length * lineHeight;
          let startY = -totalHeight / 2 + lineHeight / 2;
          
          lines.forEach((line) => {
            const textX =
              sel.textAlign === 'left'
                ? -sel.w / 2 + 2
                : sel.textAlign === 'right'
                ? sel.w / 2 - 2
                : 0;
            ctx.fillText(line, textX, startY);
            startY += lineHeight;
          });
          
          ctx.restore();
        }

        // v3.5.2: 선택 영역 경계선도 회전 적용
        ctx.save();
        const centerX = sel.x + sel.w / 2;
        const centerY = sel.y + sel.h / 2;
        ctx.translate(centerX, centerY);
        if (sel.type === 'text' && sel.textRotation) {
          ctx.rotate((sel.textRotation * Math.PI) / 180);
        }

        ctx.strokeStyle = sel.type === 'text' ? '#ef4444' : sel.type === 'image-ai' ? '#a855f7' : '#f59e0b';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(-sel.w / 2, -sel.h / 2, sel.w, sel.h);
        ctx.setLineDash([]);

        // 미리보기가 꺼져있거나 텍스트가 없을 때만 반투명 배경
        if (!previewEnabled || !replacements[sel.id] || sel.type !== 'text') {
          ctx.fillStyle = sel.type === 'text' ? 'rgba(239,68,68,0.1)' : sel.type === 'image-ai' ? 'rgba(168,85,247,0.1)' : 'rgba(245,158,11,0.1)';
          ctx.fillRect(-sel.w / 2, -sel.h / 2, sel.w, sel.h);
        }

        // ID 표시 (회전된 영역의 좌상단)
        ctx.fillStyle = sel.type === 'text' ? '#ef4444' : sel.type === 'image-ai' ? '#a855f7' : '#f59e0b';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(`#${sel.id}`, -sel.w / 2 + 4, -sel.h / 2 + 18);
        ctx.restore();
      });

      stickers.forEach((stk) => {
        const img = stickerImagesRef.current.get(stk.id);
        if (!img || !img.complete) return;

        ctx.save();
        ctx.globalAlpha = stk.opacity;
        ctx.translate(stk.x, stk.y);
        ctx.rotate((stk.rotation * Math.PI) / 180);
        const scaleX = stk.flipX ? -1 : 1;
        ctx.scale(scaleX * stk.scale, stk.scale);
        ctx.drawImage(img, -stk.w / 2, -stk.h / 2, stk.w, stk.h);
        ctx.restore();
      });

      customTexts.forEach((txt) => {
        ctx.save();
        ctx.globalAlpha = txt.opacity;
        ctx.translate(txt.x, txt.y);
        ctx.rotate((txt.rotation * Math.PI) / 180);
        ctx.font = `${txt.fontWeight} ${txt.fontSize * txt.scale}px ${txt.fontFamily || 'Noto Sans KR'}`;
        
        // v3.5: 줄바꿈 지원
        let currentX = 0;
        let currentY = 0;
        const lineHeight = txt.fontSize * txt.scale * 1.2;
        
        txt.segments.forEach((seg) => {
          if (seg.newLine) {
            currentX = 0;
            currentY += lineHeight;
          }
          ctx.fillStyle = seg.color;
          ctx.fillText(seg.text, currentX, currentY);
          currentX += ctx.measureText(seg.text).width;
        });
        ctx.restore();
      });
    };
    img.src = image;
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (eyedropperMode.active) {
      pickColor(x, y);
      return;
    }

    let clickedSticker: Sticker | null = null;
    for (let i = stickers.length - 1; i >= 0; i--) {
      const stk = stickers[i];
      const dx = x - stk.x;
      const dy = y - stk.y;
      const rad = (stk.rotation * Math.PI) / 180;
      const cos = Math.cos(-rad);
      const sin = Math.sin(-rad);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      const scaleX = stk.flipX ? -1 : 1;
      const halfW = (stk.w * stk.scale * scaleX) / 2;
      const halfH = (stk.h * stk.scale) / 2;
      if (rx >= -halfW && rx <= halfW && ry >= -halfH && ry <= halfH) {
        clickedSticker = stk;
        break;
      }
    }

    let clickedText: CustomText | null = null;
    for (let i = customTexts.length - 1; i >= 0; i--) {
      const txt = customTexts[i];
      const ctx = canvasRef.current.getContext('2d')!;
      ctx.save();
      ctx.font = `${txt.fontWeight} ${txt.fontSize * txt.scale}px ${txt.fontFamily || 'Noto Sans KR'}`;
      const fullText = txt.segments.map(s => s.text).join('');
      const width = ctx.measureText(fullText).width;
      const height = txt.fontSize * txt.scale;
      ctx.restore();

      const dx = x - txt.x;
      const dy = y - txt.y;
      const rad = (txt.rotation * Math.PI) / 180;
      const cos = Math.cos(-rad);
      const sin = Math.sin(-rad);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      if (rx >= 0 && rx <= width && ry >= -height * 0.8 && ry <= height * 0.2) {
        clickedText = txt;
        break;
      }
    }

    let clickedSelection: SelectionArea | null = null;
    for (let i = selections.length - 1; i >= 0; i--) {
      const sel = selections[i];
      // v3.5.3: 회전된 영역 클릭 감지
      const centerX = sel.x + sel.w / 2;
      const centerY = sel.y + sel.h / 2;
      const dx = x - centerX;
      const dy = y - centerY;
      
      // 텍스트 영역이고 회전이 있으면 역회전 적용
      const rotation = (sel.type === 'text' && sel.textRotation) ? sel.textRotation : 0;
      const rad = (-rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      
      if (rx >= -sel.w / 2 && rx <= sel.w / 2 && ry >= -sel.h / 2 && ry <= sel.h / 2) {
        clickedSelection = sel;
        break;
      }
    }

    if (clickedSticker) {
      setSelectedId({ id: clickedSticker.id, type: 'sticker' });
      isMoving.current = true;
      startPos.current = { x, y };
    } else if (clickedText) {
      setSelectedId({ id: clickedText.id, type: 'text' });
      isMoving.current = true;
      startPos.current = { x, y };
    } else if (clickedSelection) {
      // v3.5.3: 선택 영역도 드래그로 이동 가능
      setSelectedId({ id: clickedSelection.id, type: 'selection' });
      isMoving.current = true;
      startPos.current = { x, y };
    } else {
      isDrawing.current = true;
      startPos.current = { x, y };
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (isMoving.current && selectedId) {
      const dx = x - startPos.current.x;
      const dy = y - startPos.current.y;

      if (selectedId.type === 'sticker') {
        setStickers((prev) =>
          prev.map((s) => (s.id === selectedId.id ? { ...s, x: s.x + dx, y: s.y + dy } : s))
        );
      } else if (selectedId.type === 'text') {
        setCustomTexts((prev) =>
          prev.map((t) => (t.id === selectedId.id ? { ...t, x: t.x + dx, y: t.y + dy } : t))
        );
      } else if (selectedId.type === 'selection') {
        // v3.5.3: 선택 영역 드래그 이동
        setSelections((prev) =>
          prev.map((s) => (s.id === selectedId.id ? { ...s, x: s.x + dx, y: s.y + dy } : s))
        );
      }

      startPos.current = { x, y };
      return;
    }

    if (isDrawing.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;
      redrawCanvas();

      const startX = Math.min(startPos.current.x, x);
      const startY = Math.min(startPos.current.y, y);
      const width = Math.abs(x - startPos.current.x);
      const height = Math.abs(y - startPos.current.y);

      ctx.strokeStyle = drawMode === 'text' ? '#ef4444' : drawMode === 'image-ai' ? '#a855f7' : '#f59e0b';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(startX, startY, width, height);
      ctx.setLineDash([]);
    }
  };

  const onMouseUp = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isMoving.current) {
      isMoving.current = false;
      return;
    }

    if (isDrawing.current) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const scaleX = canvasRef.current!.width / rect.width;
      const scaleY = canvasRef.current!.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const startX = Math.min(startPos.current.x, x);
      const startY = Math.min(startPos.current.y, y);
      const width = Math.abs(x - startPos.current.x);
      const height = Math.abs(y - startPos.current.y);

      if (width > 10 && height > 10 && selections.length < MAX_SELECTIONS) {
        const newId = Date.now();
        
        // 🚀 즉시 분석 (1ms 이내!)
        let bgColor = '#ffffff';
        let textColor = '#000000';
        let fontSize = 32;

        if (autoAnalyzeEnabled) {
          if (drawMode === 'text') {
            const analysis = analyzeTextAreaFast(startX, startY, width, height);
            bgColor = analysis.bgColor;
            textColor = analysis.textColor;
            fontSize = analysis.fontSize;
          } else if (drawMode === 'image-replace') {
            bgColor = detectSurroundingColor(startX, startY, width, height);
          }
        }
        
        const newSelection: SelectionArea = {
          id: newId,
          x: startX,
          y: startY,
          w: width,
          h: height,
          type: drawMode,
          textColor: textColor,
          textBgColor: bgColor,
          fontSize: fontSize,
          fontWeight: 'normal',
          textAlign: 'center',
          fontFamily: 'Noto Sans KR',
        };

        setSelections((prev) => [...prev, newSelection]);
        addToHistory();
      }

      isDrawing.current = false;
      redrawCanvas();
    }
  };

  const pickColor = (x: number, y: number) => {
    if (!originalCanvasRef.current || !eyedropperMode.selectionId) return;

    const ctx = originalCanvasRef.current.getContext('2d')!;
    const pixel = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const hex = rgbToHex(pixel[0], pixel[1], pixel[2]);

    if (eyedropperMode.target === 'text') {
      setSelections((prev) =>
        prev.map((s) => (s.id === eyedropperMode.selectionId ? { ...s, textColor: hex } : s))
      );
    } else {
      setSelections((prev) =>
        prev.map((s) => (s.id === eyedropperMode.selectionId ? { ...s, textBgColor: hex } : s))
      );
    }

    setEyedropperMode({ active: false, selectionId: null, target: 'text' });
  };

  const removeSelection = (id: number) => {
    setSelections((prev) => prev.filter((s) => s.id !== id));
    setReplacements((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    replacementImagesRef.current.delete(id);
    addToHistory();
  };

  const updateSelection = (id: number, updates: Partial<SelectionArea>) => {
    setSelections((prev) => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  };

  // 재분석 함수 (수동)
  const reanalyzeSelection = (id: number) => {
    const sel = selections.find(s => s.id === id);
    if (!sel || sel.type !== 'text') return;

    const analysis = analyzeTextAreaFast(sel.x, sel.y, sel.w, sel.h);
    updateSelection(id, {
      textColor: analysis.textColor,
      textBgColor: analysis.bgColor,
      fontSize: analysis.fontSize,
    });
  };

  const handleReplacementUpload = (id: number, file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target!.result as string;
      const img = new Image();
      img.onload = () => {
        replacementImagesRef.current.set(id, img);
        updateSelection(id, { replacementImage: dataUrl });
        redrawCanvas();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleStickerUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target!.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current!;
        const newSticker: Sticker = {
          id: Date.now(),
          src: dataUrl,
          x: canvas.width / 2,
          y: canvas.height / 2,
          w: img.width,
          h: img.height,
          rotation: 0,
          flipX: false,
          opacity: 1,
          scale: 1,
        };
        stickerImagesRef.current.set(newSticker.id, img);
        setStickers((prev) => [...prev, newSticker]);
        addToHistory();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const removeSticker = (id: number) => {
    setStickers((prev) => prev.filter((s) => s.id !== id));
    stickerImagesRef.current.delete(id);
    addToHistory();
  };

  const addCustomText = () => {
    const canvas = canvasRef.current!;
    const newText: CustomText = {
      id: Date.now(),
      segments: [
        { text: '텍스트', color: DEFAULT_COLORS[0] },
        { text: '입력', color: DEFAULT_COLORS[1] },
      ],
      x: canvas.width / 2,
      y: canvas.height / 2,
      fontSize: 48,
      scale: 1,
      opacity: 1,
      fontWeight: 'normal',
      rotation: 0,
      fontFamily: 'Noto Sans KR',
    };
    setCustomTexts((prev) => [...prev, newText]);
    addToHistory();
  };

  const removeCustomText = (id: number) => {
    setCustomTexts((prev) => prev.filter((t) => t.id !== id));
    addToHistory();
  };

  const updateTextSegment = (textId: number, segIdx: number, field: 'text' | 'color', value: string) => {
    setCustomTexts((prev) =>
      prev.map((txt) => {
        if (txt.id !== textId) return txt;
        const newSegments = [...txt.segments];
        newSegments[segIdx] = { ...newSegments[segIdx], [field]: value };
        return { ...txt, segments: newSegments };
      })
    );
  };

  const addToHistory = () => {
    const newState: HistoryState = {
      selections: [...selections],
      replacements: { ...replacements },
      stickers: [...stickers],
      customTexts: [...customTexts],
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newState);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const undo = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const state = history[newIndex];
      setSelections(state.selections);
      setReplacements(state.replacements);
      setStickers(state.stickers);
      setCustomTexts(state.customTexts);
      setHistoryIndex(newIndex);
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const state = history[newIndex];
      setSelections(state.selections);
      setReplacements(state.replacements);
      setStickers(state.stickers);
      setCustomTexts(state.customTexts);
      setHistoryIndex(newIndex);
    }
  };

  const wrapText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
    // v3.4: 줄바꿈 문자 지원
    return wrapTextWithNewlines(ctx, text, maxWidth);
  };

  const handleRestore = async () => {
    if (!canvasRef.current || !originalImageData || selections.length === 0) return;

    try {
      setIsProcessing(true);
      setProcessStep('준비 중...');

      const canvas = document.createElement('canvas');
      canvas.width = canvasRef.current.width;
      canvas.height = canvasRef.current.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(originalImageData, 0, 0);

      const textSelections = selections.filter((s) => s.type === 'text');
      const imageAISelections = selections.filter((s) => s.type === 'image-ai');
      const imageReplaceSelections = selections.filter((s) => s.type === 'image-replace');

      for (const sel of textSelections) {
        setProcessStep(`텍스트 영역 #${sel.id} 복원 중...`);
        const newText = replacements[sel.id] || '';
        
        // v3.5: 회전 지원
        ctx.save();
        const centerX = sel.x + sel.w / 2;
        const centerY = sel.y + sel.h / 2;
        ctx.translate(centerX, centerY);
        if (sel.textRotation) {
          ctx.rotate((sel.textRotation * Math.PI) / 180);
        }
        
        // 배경 채우기 (중심 기준)
        ctx.fillStyle = sel.textBgColor || '#ffffff';
        ctx.fillRect(-sel.w / 2, -sel.h / 2, sel.w, sel.h);

        if (newText) {
          ctx.fillStyle = sel.textColor || '#000000';
          ctx.font = `${sel.fontWeight || 'normal'} ${sel.fontSize || 32}px ${sel.fontFamily || 'Noto Sans KR'}`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = sel.textAlign || 'center';

          // v3.5.1: 패딩 최소화 (sel.w - 4)
          const lines = wrapText(ctx, newText, sel.w - 4);
          const lineHeight = (sel.fontSize || 32) * 1.2;
          const totalHeight = lines.length * lineHeight;
          let startY = -totalHeight / 2 + lineHeight / 2;

          lines.forEach((line) => {
            const textX =
              sel.textAlign === 'left'
                ? -sel.w / 2 + 2
                : sel.textAlign === 'right'
                ? sel.w / 2 - 2
                : 0;
            ctx.fillText(line, textX, startY);
            startY += lineHeight;
          });
        }
        ctx.restore();
      }

      for (const sel of imageAISelections) {
        setProcessStep(`AI 이미지 #${sel.id} 복원 중...`);
        const prompt = replacements[sel.id] || '';
        if (!prompt) continue;

        try {
          let apiKey = manualKey || localStorage.getItem(STORAGE_KEY);
          if (!apiKey && (window as any).aistudio?.getSelectedApiKey) {
            apiKey = await (window as any).aistudio.getSelectedApiKey();
          }

          if (!apiKey) {
            alert('API Key가 필요합니다.');
            continue;
          }

          const genAI = new GoogleGenAI({ apiKey });
          const imageDataUrl = canvas.toDataURL('image/png');
          const base64 = imageDataUrl.split(',')[1];

          const response = await genAI.models.generateContent({
            model: 'gemini-2.0-flash-exp-image-generation',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: { mimeType: 'image/png', data: base64 },
                  },
                  {
                    text: `영역 (${sel.x}, ${sel.y}, ${sel.w}x${sel.h})에 "${prompt}"을 자연스럽게 그려주세요.`,
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
            },
          });

          const parts = response.candidates?.[0]?.content?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                const aiImage = new Image();
                await new Promise<void>((resolve) => {
                  aiImage.onload = () => {
                    ctx.drawImage(aiImage, sel.x, sel.y, sel.w, sel.h);
                    resolve();
                  };
                  aiImage.src = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                });
                break;
              }
            }
          }
        } catch (error: any) {
          console.error('AI 이미지 생성 실패:', error);
        }
      }

      for (const sel of imageReplaceSelections) {
        if (!sel.replacementImage) continue;
        setProcessStep(`이미지 #${sel.id} 교체 중...`);

        ctx.fillStyle = sel.textBgColor || '#ffffff';
        ctx.fillRect(sel.x, sel.y, sel.w, sel.h);

        const img = replacementImagesRef.current.get(sel.id);
        if (img && img.complete) {
          ctx.save();
          ctx.translate(sel.x + sel.w / 2, sel.y + sel.h / 2);
          if (sel.imageRotation) ctx.rotate((sel.imageRotation * Math.PI) / 180);
          const scaleX = sel.imageFlipX ? -1 : 1;
          const scaleY = sel.imageFlipY ? -1 : 1;
          ctx.scale(scaleX, scaleY);
          ctx.drawImage(img, -sel.w / 2, -sel.h / 2, sel.w, sel.h);
          ctx.restore();
        }
      }

      for (const stk of stickers) {
        const img = stickerImagesRef.current.get(stk.id);
        if (!img || !img.complete) continue;

        ctx.save();
        ctx.globalAlpha = stk.opacity;
        ctx.translate(stk.x, stk.y);
        ctx.rotate((stk.rotation * Math.PI) / 180);
        const scaleX = stk.flipX ? -1 : 1;
        ctx.scale(scaleX * stk.scale, stk.scale);
        ctx.drawImage(img, -stk.w / 2, -stk.h / 2, stk.w, stk.h);
        ctx.restore();
      }

      for (const txt of customTexts) {
        ctx.save();
        ctx.globalAlpha = txt.opacity;
        ctx.translate(txt.x, txt.y);
        ctx.rotate((txt.rotation * Math.PI) / 180);
        ctx.font = `${txt.fontWeight} ${txt.fontSize * txt.scale}px ${txt.fontFamily || 'Noto Sans KR'}`;

        // v3.5: 줄바꿈 지원
        let currentX = 0;
        let currentY = 0;
        const lineHeight = txt.fontSize * txt.scale * 1.2;
        
        txt.segments.forEach((seg) => {
          if (seg.newLine) {
            currentX = 0;
            currentY += lineHeight;
          }
          ctx.fillStyle = seg.color;
          ctx.fillText(seg.text, currentX, currentY);
          currentX += ctx.measureText(seg.text).width;
        });
        ctx.restore();
      }

      setResultImage(canvas.toDataURL('image/png'));
      setProcessStep('완료!');

      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch (error) {
      console.error('복원 실패:', error);
      setProcessStep('오류 발생');
    } finally {
      setTimeout(() => {
        setIsProcessing(false);
        setProcessStep('');
      }, 1000);
    }
  };

  const downloadResult = () => {
    if (!resultImage) return;
    const link = document.createElement('a');
    link.download = `restored_${Date.now()}.png`;
    link.href = resultImage;
    link.click();
  };

  const modeInfo = {
    text: { icon: '📝', label: '텍스트 교정', color: 'red' },
    'image-ai': { icon: '🎨', label: 'AI 이미지 수정', color: 'purple' },
    'image-replace': { icon: '🖼️', label: '이미지 대체', color: 'amber' },
  }[drawMode];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 flex flex-col">
      <header className="max-w-7xl mx-auto mb-6 w-full">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              🎯 록신 이미지 에디터 v3.5.5
            </h1>
            <p className="text-sm text-slate-500 mt-1">이미지 회전 미세 조정 지원</p>
          </div>
          <div className="flex items-center gap-3">
            {pdfDoc && (
              <div className="flex items-center gap-2 bg-white px-3 py-2 rounded-lg shadow-sm">
                <button
                  onClick={() => changePage(-1)}
                  disabled={currentPageNum <= 1}
                  className="px-2 py-1 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-50"
                >
                  ◀
                </button>
                <span className="text-sm font-medium">
                  {currentPageNum} / {numPages}
                </span>
                <button
                  onClick={() => changePage(1)}
                  disabled={currentPageNum >= numPages}
                  className="px-2 py-1 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-50"
                >
                  ▶
                </button>
              </div>
            )}
            <label className="cursor-pointer px-4 py-2 bg-white hover:bg-slate-50 rounded-xl border border-slate-200 shadow-sm transition font-medium text-sm">
              📁 파일 업로드
              <input type="file" accept=".pdf,image/*" onChange={handleFileChange} className="hidden" />
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid lg:grid-cols-4 gap-6 flex-1 w-full">
        <aside className="lg:col-span-1 bg-white rounded-2xl p-5 shadow-sm border border-slate-100 h-fit sticky top-6 space-y-4 max-h-[calc(100vh-120px)] overflow-y-auto">
          {/* 자동 분석 토글 */}
          <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-xl p-3 border border-emerald-200">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-emerald-800 text-sm">⚡ 자동 감지</h3>
                <p className="text-[10px] text-emerald-600">즉시 크기/색상 자동 설정</p>
              </div>
              <button
                onClick={() => setAutoAnalyzeEnabled(!autoAnalyzeEnabled)}
                className={`w-12 h-6 rounded-full transition-all duration-300 ${
                  autoAnalyzeEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow transition-transform duration-300 ${
                    autoAnalyzeEnabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* v3.4: 실시간 미리보기 토글 */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-3 border border-blue-200">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-blue-800 text-sm">👁️ 실시간 미리보기</h3>
                <p className="text-[10px] text-blue-600">텍스트 입력 시 바로 표시</p>
              </div>
              <button
                onClick={() => setPreviewEnabled(!previewEnabled)}
                className={`w-12 h-6 rounded-full transition-all duration-300 ${
                  previewEnabled ? 'bg-blue-500' : 'bg-slate-300'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow transition-transform duration-300 ${
                    previewEnabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 모드 선택 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">모드 선택</h3>
            <div className="grid grid-cols-3 gap-2">
              {(['text', 'image-ai', 'image-replace'] as SelectionType[]).map((mode) => {
                const info = {
                  text: { icon: '📝', label: '텍스트', color: 'red' },
                  'image-ai': { icon: '🎨', label: 'AI수정', color: 'purple' },
                  'image-replace': { icon: '🖼️', label: '이미지', color: 'amber' },
                }[mode];
                return (
                  <button
                    key={mode}
                    onClick={() => setDrawMode(mode)}
                    className={`p-2 rounded-xl text-center transition-all ${
                      drawMode === mode
                        ? `bg-${info.color}-100 border-2 border-${info.color}-400 shadow-sm`
                        : 'bg-slate-50 border-2 border-transparent hover:bg-slate-100'
                    }`}
                  >
                    <div className="text-xl">{info.icon}</div>
                    <div className="text-[10px] font-medium text-slate-600">{info.label}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 히스토리 & 스티커 */}
          <section className="flex gap-2">
            <button
              onClick={undo}
              disabled={historyIndex <= 0}
              className="flex-1 py-2 bg-slate-100 rounded-lg text-sm font-medium hover:bg-slate-200 disabled:opacity-50 transition"
            >
              ↩️ 실행취소
            </button>
            <button
              onClick={redo}
              disabled={historyIndex >= history.length - 1}
              className="flex-1 py-2 bg-slate-100 rounded-lg text-sm font-medium hover:bg-slate-200 disabled:opacity-50 transition"
            >
              ↪️ 다시실행
            </button>
          </section>

          <section className="flex gap-2">
            <label className="flex-1 py-2 bg-gradient-to-r from-pink-100 to-rose-100 rounded-lg text-sm font-medium text-center cursor-pointer hover:from-pink-200 hover:to-rose-200 transition">
              🎀 스티커 추가
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && handleStickerUpload(e.target.files[0])}
                className="hidden"
              />
            </label>
            <button
              onClick={addCustomText}
              disabled={!image}
              className="flex-1 py-2 bg-gradient-to-r from-violet-100 to-purple-100 rounded-lg text-sm font-medium hover:from-violet-200 hover:to-purple-200 disabled:opacity-50 transition"
            >
              🌈 멀티컬러 글씨
            </button></section>

          {/* v3.4: API Key 섹션 개선 */}
          {isKeySelected === false && (
            <section className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl p-4 border border-amber-200">
              <h3 className="font-bold text-amber-800 text-sm mb-3 flex items-center gap-2">
                🔑 API Key 설정
                {keySaved && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">저장됨</span>}
              </h3>
              <div className="space-y-3">
                <div className="relative">
                  <input
                    type="password"
                    value={manualKey}
                    onChange={(e) => {
                      setManualKey(e.target.value);
                      setKeySaved(false);
                    }}
                    placeholder="Gemini API Key 입력"
                    className="w-full px-3 py-2.5 text-sm border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-400 focus:border-amber-400 outline-none transition"
                  />
                </div>
                <button
                  onClick={() => {
                    if (manualKey.length > 10) {
                      localStorage.setItem(STORAGE_KEY, manualKey);
                      setIsKeySelected(true);
                      setKeySaved(true);
                    }
                  }}
                  disabled={manualKey.length <= 10}
                  className={`w-full py-2.5 rounded-lg text-sm font-bold transition ${
                    manualKey.length > 10
                      ? 'bg-amber-500 text-white hover:bg-amber-600'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {keySaved ? '✓ 저장됨' : '💾 저장하기'}
                </button>
                <p className="text-[10px] text-amber-600">
                  * AI 이미지 수정 기능에 필요합니다
                </p>
              </div>
            </section>
          )}

          {/* API Key 저장됨 표시 (키가 있을 때) */}
          {isKeySelected === true && (
            <section className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-3 border border-green-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-green-600">✓</span>
                  <span className="text-sm font-medium text-green-800">API Key 설정됨</span>
                </div>
                <button
                  onClick={() => {
                    localStorage.removeItem(STORAGE_KEY);
                    setManualKey('');
                    setIsKeySelected(false);
                    setKeySaved(false);
                  }}
                  className="text-xs text-green-600 hover:text-red-500 transition"
                >
                  변경
                </button>
              </div>
            </section>
          )}

          {/* 선택 영역 목록 */}
          {selections.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                선택 영역 ({selections.length})
              </h3>
              {selections.map((sel) => (
                <div
                  key={sel.id}
                  className={`bg-slate-50 rounded-xl p-3 border transition-all ${
                    sel.type === 'text' ? 'border-red-200' : 
                    sel.type === 'image-ai' ? 'border-purple-200' : 'border-amber-200'
                  }`}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      sel.type === 'text' ? 'bg-red-100 text-red-700' : 
                      sel.type === 'image-ai' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      #{sel.id}
                    </span>
                    <button
                      onClick={() => removeSelection(sel.id)}
                      className="text-slate-400 hover:text-red-500 transition"
                    >
                      ✕
                    </button>
                  </div>

                  {sel.type === 'text' && (
                    <>
                      {/* v3.4: textarea로 줄바꿈 지원 */}
                      <textarea
                        value={replacements[sel.id] || ''}
                        onChange={(e) =>
                          setReplacements((prev) => ({
                            ...prev,
                            [sel.id]: e.target.value.slice(0, MAX_CHAR_LIMIT),
                          }))
                        }
                        placeholder="교정할 텍스트 입력&#10;(Enter로 줄바꿈)"
                        className="w-full p-2 text-sm border border-slate-200 rounded-lg resize-none h-20 mb-2"
                      />
                      
                      <div className="space-y-2">
                        {/* 크기 - v3.4: 실시간 반영 */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-12">크기</span>
                          <input
                            type="range"
                            min="10"
                            max="200"
                            value={sel.fontSize || 32}
                            onChange={(e) => updateSelection(sel.id, { fontSize: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-red-500"
                          />
                          <input
                            type="number"
                            min="10"
                            max="200"
                            value={sel.fontSize || 32}
                            onChange={(e) => updateSelection(sel.id, { fontSize: parseInt(e.target.value) || 32 })}
                            className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                          <span className="text-[10px]">px</span>
                        </div>

                        {/* 글자색 */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-12">글자색</span>
                          <input
                            type="color"
                            value={sel.textColor || '#000000'}
                            onChange={(e) => updateSelection(sel.id, { textColor: e.target.value })}
                            className="w-6 h-6 rounded cursor-pointer"
                          />
                          <span className="text-[10px] font-mono flex-1">{sel.textColor}</span>
                          <button
                            onClick={() => setEyedropperMode({ active: true, selectionId: sel.id, target: 'text' })}
                            className="text-xs px-2 py-1 bg-slate-100 rounded hover:bg-slate-200"
                            title="이미지에서 색상 추출"
                          >
                            💧
                          </button>
                        </div>

                        {/* 배경색 */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-12">배경색</span>
                          <input
                            type="color"
                            value={sel.textBgColor || '#ffffff'}
                            onChange={(e) => updateSelection(sel.id, { textBgColor: e.target.value })}
                            className="w-6 h-6 rounded cursor-pointer"
                          />
                          <span className="text-[10px] font-mono flex-1">{sel.textBgColor}</span>
                          <button
                            onClick={() => setEyedropperMode({ active: true, selectionId: sel.id, target: 'bg' })}
                            className="text-xs px-2 py-1 bg-slate-100 rounded hover:bg-slate-200"
                            title="이미지에서 색상 추출"
                          >
                            💧
                          </button>
                        </div>

                        {/* 폰트 */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-12">폰트</span>
                          <select
                            value={sel.fontFamily || 'Noto Sans KR'}
                            onChange={(e) => updateSelection(sel.id, { fontFamily: e.target.value })}
                            className="flex-1 text-[10px] p-1 border border-slate-200 rounded"
                          >
                            {FONT_OPTIONS.map((font) => (
                              <option key={font.value} value={font.value}>
                                {font.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* 정렬 & 굵기 */}
                        <div className="flex gap-1">
                          {(['left', 'center', 'right'] as const).map((align) => (
                            <button
                              key={align}
                              onClick={() => updateSelection(sel.id, { textAlign: align })}
                              className={`flex-1 py-1 text-[10px] rounded transition ${
                                sel.textAlign === align
                                  ? 'bg-slate-700 text-white'
                                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              {align === 'left' ? '◀' : align === 'center' ? '◆' : '▶'}
                            </button>
                          ))}
                          <button
                            onClick={() =>
                              updateSelection(sel.id, {
                                fontWeight: sel.fontWeight === 'bold' ? 'normal' : 'bold',
                              })
                            }
                            className={`flex-1 py-1 text-[10px] rounded transition ${
                              sel.fontWeight === 'bold'
                                ? 'bg-slate-700 text-white'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                            }`}
                          >
                            <b>B</b>
                          </button>
                        </div>

                        {/* v3.5.1: 텍스트 회전 (미세 조정 가능) */}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-12">회전</span>
                          <input
                            type="range"
                            min="-180"
                            max="180"
                            step="1"
                            value={sel.textRotation || 0}
                            onChange={(e) => updateSelection(sel.id, { textRotation: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-red-500"
                          />
                          <input
                            type="number"
                            min="-180"
                            max="180"
                            value={sel.textRotation || 0}
                            onChange={(e) => {
                              let val = parseInt(e.target.value) || 0;
                              val = Math.max(-180, Math.min(180, val));
                              updateSelection(sel.id, { textRotation: val });
                            }}
                            className="w-12 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                          <span className="text-[10px]">°</span>
                          <button
                            onClick={() => updateSelection(sel.id, { textRotation: 0 })}
                            className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200"
                          >
                            0
                          </button>
                        </div>

                        {/* v3.5.4: 영역 크기 조정 */}
                        <div className="bg-slate-100 rounded-lg p-2 space-y-2">
                          <div className="text-[10px] text-slate-500 font-medium">📐 영역 크기</div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-8">너비</span>
                            <input
                              type="range"
                              min="20"
                              max="1000"
                              value={Math.round(sel.w)}
                              onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) })}
                              className="flex-1 h-1 accent-blue-500"
                            />
                            <input
                              type="number"
                              min="20"
                              max="2000"
                              value={Math.round(sel.w)}
                              onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) || 100 })}
                              className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-8">높이</span>
                            <input
                              type="range"
                              min="20"
                              max="500"
                              value={Math.round(sel.h)}
                              onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) })}
                              className="flex-1 h-1 accent-blue-500"
                            />
                            <input
                              type="number"
                              min="20"
                              max="1000"
                              value={Math.round(sel.h)}
                              onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) || 50 })}
                              className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                            />
                          </div>
                        </div>

                        {/* 재분석 버튼 */}
                        <button
                          onClick={() => reanalyzeSelection(sel.id)}
                          className="w-full py-1 text-[10px] bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition"
                        >
                          🔄 자동 감지 다시 실행
                        </button>
                      </div>
                    </>
                  )}

                  {sel.type === 'image-ai' && (
                    <div className="space-y-2">
                      <textarea
                        value={replacements[sel.id] || ''}
                        onChange={(e) =>
                          setReplacements((prev) => ({
                            ...prev,
                            [sel.id]: e.target.value.slice(0, MAX_CHAR_LIMIT),
                          }))
                        }
                        placeholder="AI에게 요청할 내용"
                        className="w-full p-2 text-sm border border-slate-200 rounded-lg resize-none h-16"
                      />
                      {/* v3.5.4: AI 영역 크기 조정 */}
                      <div className="bg-slate-100 rounded-lg p-2 space-y-2">
                        <div className="text-[10px] text-slate-500 font-medium">📐 영역 크기</div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-8">너비</span>
                          <input
                            type="range"
                            min="20"
                            max="1000"
                            value={Math.round(sel.w)}
                            onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-purple-500"
                          />
                          <input
                            type="number"
                            min="20"
                            max="2000"
                            value={Math.round(sel.w)}
                            onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) || 100 })}
                            className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-8">높이</span>
                          <input
                            type="range"
                            min="20"
                            max="500"
                            value={Math.round(sel.h)}
                            onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-purple-500"
                          />
                          <input
                            type="number"
                            min="20"
                            max="1000"
                            value={Math.round(sel.h)}
                            onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) || 50 })}
                            className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {sel.type === 'image-replace' && (
                    <div className="space-y-2">
                      <label className="block p-2 bg-slate-100 rounded-lg text-center cursor-pointer hover:bg-slate-200 transition">
                        <span className="text-xs text-slate-600">
                          {sel.replacementImage ? '🖼️ 이미지 교체' : '📁 이미지 선택'}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) =>
                            e.target.files?.[0] && handleReplacementUpload(sel.id, e.target.files[0])
                          }
                          className="hidden"
                        />
                      </label>
                      {sel.replacementImage && (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-12">회전</span>
                            <input
                              type="range"
                              min="-180"
                              max="180"
                              step="1"
                              value={sel.imageRotation || 0}
                              onChange={(e) => updateSelection(sel.id, { imageRotation: parseInt(e.target.value) })}
                              className="flex-1 h-1 accent-amber-500"
                            />
                            <input
                              type="number"
                              min="-180"
                              max="180"
                              value={sel.imageRotation || 0}
                              onChange={(e) => {
                                let val = parseInt(e.target.value) || 0;
                                val = Math.max(-180, Math.min(180, val));
                                updateSelection(sel.id, { imageRotation: val });
                              }}
                              className="w-12 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                            />
                            <span className="text-[10px]">°</span>
                            <button
                              onClick={() => updateSelection(sel.id, { imageRotation: 0 })}
                              className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200"
                            >
                              0
                            </button>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => updateSelection(sel.id, { imageFlipX: !sel.imageFlipX })}
                              className={`flex-1 py-1 text-[10px] rounded transition ${
                                sel.imageFlipX ? 'bg-amber-500 text-white' : 'bg-slate-100'
                              }`}
                            >
                              ↔️ 좌우
                            </button>
                            <button
                              onClick={() => updateSelection(sel.id, { imageFlipY: !sel.imageFlipY })}
                              className={`flex-1 py-1 text-[10px] rounded transition ${
                                sel.imageFlipY ? 'bg-amber-500 text-white' : 'bg-slate-100'
                              }`}
                            >
                              ↕️ 상하
                            </button>
                          </div>
                        </>
                      )}
                      {/* v3.5.4: 이미지 영역 크기 조정 */}
                      <div className="bg-slate-100 rounded-lg p-2 space-y-2 mt-2">
                        <div className="text-[10px] text-slate-500 font-medium">📐 영역 크기</div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-8">너비</span>
                          <input
                            type="range"
                            min="20"
                            max="1000"
                            value={Math.round(sel.w)}
                            onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-amber-500"
                          />
                          <input
                            type="number"
                            min="20"
                            max="2000"
                            value={Math.round(sel.w)}
                            onChange={(e) => updateSelection(sel.id, { w: parseInt(e.target.value) || 100 })}
                            className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500 w-8">높이</span>
                          <input
                            type="range"
                            min="20"
                            max="500"
                            value={Math.round(sel.h)}
                            onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) })}
                            className="flex-1 h-1 accent-amber-500"
                          />
                          <input
                            type="number"
                            min="20"
                            max="1000"
                            value={Math.round(sel.h)}
                            onChange={(e) => updateSelection(sel.id, { h: parseInt(e.target.value) || 50 })}
                            className="w-14 text-[10px] font-mono text-center border border-slate-200 rounded py-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          {/* 스티커 목록 */}
          {stickers.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                스티커 ({stickers.length})
              </h3>
              {stickers.map((stk) => (
                <div key={stk.id} className="bg-pink-50 rounded-xl p-3 border border-pink-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-pink-700">🎀 스티커</span>
                    <button
                      onClick={() => removeSticker(stk.id)}
                      className="text-slate-400 hover:text-red-500 transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">크기</span>
                      <input
                        type="range"
                        min="5"
                        max="1000"
                        value={stk.scale * 100}
                        onChange={(e) =>
                          setStickers((prev) =>
                            prev.map((s) =>
                              s.id === stk.id ? { ...s, scale: parseInt(e.target.value) / 100 } : s
                            )
                          )
                        }
                        className="flex-1 h-1 accent-pink-500"
                      />
                      <span className="text-[10px] w-10">{Math.round(stk.scale * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">투명도</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={stk.opacity}
                        onChange={(e) =>
                          setStickers((prev) =>
                            prev.map((s) =>
                              s.id === stk.id ? { ...s, opacity: parseFloat(e.target.value) } : s
                            )
                          )
                        }
                        className="flex-1 h-1 accent-pink-500"
                      />
                      <span className="text-[10px] w-10">{Math.round(stk.opacity * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">회전</span>
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        step="5"
                        value={stk.rotation}
                        onChange={(e) =>
                          setStickers((prev) =>
                            prev.map((s) =>
                              s.id === stk.id ? { ...s, rotation: parseInt(e.target.value) } : s
                            )
                          )
                        }
                        className="flex-1 h-1 accent-pink-500"
                      />
                      <span className="text-[10px] w-10">{stk.rotation}°</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setStickers((prev) =>
                            prev.map((s) => (s.id === stk.id ? { ...s, flipX: !s.flipX } : s))
                          )
                        }
                        className={`flex-1 py-1 text-[10px] rounded transition ${
                          stk.flipX ? 'bg-pink-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        ↔️ 좌우반전
                      </button>
                      <button
                        onClick={() =>
                          setStickers((prev) =>
                            prev.map((s) => (s.id === stk.id ? { ...s, rotation: 0 } : s))
                          )
                        }
                        className="flex-1 py-1 text-[10px] bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
                      >
                        회전 초기화
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* 멀티컬러 텍스트 목록 */}
          {customTexts.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                멀티컬러 텍스트 ({customTexts.length})
              </h3>
              {customTexts.map((txt) => (
                <div key={txt.id} className="bg-violet-50 rounded-xl p-3 border border-violet-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-violet-700">🌈 멀티컬러</span>
                    <button
                      onClick={() => removeCustomText(txt.id)}
                      className="text-slate-400 hover:text-red-500 transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-2 mb-3">
                    {txt.segments.map((seg, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        {/* v3.5: 줄바꿈 토글 (첫 번째 세그먼트 제외) */}
                        {idx > 0 && (
                          <button
                            onClick={() =>
                              setCustomTexts((prev) =>
                                prev.map((t) =>
                                  t.id === txt.id
                                    ? {
                                        ...t,
                                        segments: t.segments.map((s, i) =>
                                          i === idx ? { ...s, newLine: !s.newLine } : s
                                        ),
                                      }
                                    : t
                                )
                              )
                            }
                            className={`text-[10px] px-1.5 py-1 rounded transition ${
                              seg.newLine
                                ? 'bg-violet-500 text-white'
                                : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                            }`}
                            title={seg.newLine ? '같은 줄로' : '줄바꿈'}
                          >
                            ↵
                          </button>
                        )}
                        {idx === 0 && <div className="w-6" />}
                        <input
                          type="color"
                          value={seg.color}
                          onChange={(e) => updateTextSegment(txt.id, idx, 'color', e.target.value)}
                          className="w-6 h-6 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={seg.text}
                          onChange={(e) => updateTextSegment(txt.id, idx, 'text', e.target.value)}
                          className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded"
                        />
                        {txt.segments.length > 1 && (
                          <button
                            onClick={() =>
                              setCustomTexts((prev) =>
                                prev.map((t) =>
                                  t.id === txt.id
                                    ? { ...t, segments: t.segments.filter((_, i) => i !== idx) }
                                    : t
                                )
                              )
                            }
                            className="text-xs text-slate-400 hover:text-red-500"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        setCustomTexts((prev) =>
                          prev.map((t) =>
                            t.id === txt.id
                              ? {
                                  ...t,
                                  segments: [
                                    ...t.segments,
                                    {
                                      text: '새텍스트',
                                      color: DEFAULT_COLORS[t.segments.length % DEFAULT_COLORS.length],
                                    },
                                  ],
                                }
                              : t
                          )
                        )
                      }
                      className="w-full py-1 text-[10px] bg-violet-100 text-violet-700 rounded hover:bg-violet-200"
                    >
                      + 색상 추가
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 w-12">폰트</span>
                      <select
                        value={txt.fontFamily || 'Noto Sans KR'}
                        onChange={(e) =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id ? { ...t, fontFamily: e.target.value } : t
                            )
                          )
                        }
                        className="flex-1 text-[10px] p-1 border border-slate-200 rounded"
                      >
                        {FONT_OPTIONS.map((font) => (
                          <option key={font.value} value={font.value}>
                            {font.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">크기</span>
                      <input
                        type="range"
                        min="12"
                        max="200"
                        value={txt.fontSize}
                        onChange={(e) =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id ? { ...t, fontSize: parseInt(e.target.value) } : t
                            )
                          )
                        }
                        className="flex-1 h-1 accent-violet-500"
                      />
                      <span className="text-[10px] w-10">{txt.fontSize}px</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">배율</span>
                      <input
                        type="range"
                        min="10"
                        max="500"
                        value={txt.scale * 100}
                        onChange={(e) =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id ? { ...t, scale: parseInt(e.target.value) / 100 } : t
                            )
                          )
                        }
                        className="flex-1 h-1 accent-violet-500"
                      />
                      <span className="text-[10px] w-10">{Math.round(txt.scale * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">투명도</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={txt.opacity}
                        onChange={(e) =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id ? { ...t, opacity: parseFloat(e.target.value) } : t
                            )
                          )
                        }
                        className="flex-1 h-1 accent-violet-500"
                      />
                      <span className="text-[10px] w-10">{Math.round(txt.opacity * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-10">회전</span>
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        step="5"
                        value={txt.rotation}
                        onChange={(e) =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id ? { ...t, rotation: parseInt(e.target.value) } : t
                            )
                          )
                        }
                        className="flex-1 h-1 accent-violet-500"
                      />
                      <span className="text-[10px] w-10">{txt.rotation}°</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setCustomTexts((prev) =>
                            prev.map((t) =>
                              t.id === txt.id
                                ? { ...t, fontWeight: t.fontWeight === 'bold' ? 'normal' : 'bold' }
                                : t
                            )
                          )
                        }
                        className={`flex-1 py-1 text-[10px] rounded transition ${
                          txt.fontWeight === 'bold'
                            ? 'bg-slate-700 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        <b>B</b> 굵게
                      </button>
                      <button
                        onClick={() =>
                          setCustomTexts((prev) =>
                            prev.map((t) => (t.id === txt.id ? { ...t, rotation: 0 } : t))
                          )
                        }
                        className="flex-1 py-1 text-[10px] bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
                      >
                        회전 초기화
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* 실행 버튼 */}
          <div className="space-y-2 pt-2 border-t border-slate-100">
            <button
              onClick={handleRestore}
              disabled={isProcessing || !image || selections.length === 0}
              className={`w-full py-3 rounded-xl font-semibold text-white transition ${
                isProcessing || !image || selections.length === 0
                  ? 'bg-slate-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-lg'
              }`}
            >
              {isProcessing ? processStep : '🚀 교정 실행'}
            </button>
            <button
              onClick={downloadResult}
              disabled={!resultImage || isProcessing}
              className={`w-full py-3 rounded-xl font-bold text-white transition ${
                !resultImage || isProcessing
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              📥 결과물 다운로드
            </button>
          </div>
        </aside>

        <section className="lg:col-span-3 overflow-y-auto flex flex-col gap-6">
          <div
            className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex justify-center items-start min-h-[400px]"
            style={{
              background:
                'linear-gradient(45deg, #f8fafc 25%, transparent 25%), linear-gradient(-45deg, #f8fafc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f8fafc 75%), linear-gradient(-45deg, transparent 75%, #f8fafc 75%)',
              backgroundSize: '20px 20px',
              backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
              backgroundColor: '#fff',
            }}
          >
            {!image ? (
              <div className="py-20 text-slate-400 flex flex-col items-center">
                <div className="text-5xl mb-4">📁</div>
                <p className="text-sm font-semibold">PDF 또는 이미지를 업로드하세요</p>
              </div>
            ) : (
              <div className="relative inline-block">
                <canvas
                  ref={canvasRef}
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                  className={`shadow-lg rounded-lg ${eyedropperMode.active ? 'cursor-cell' : 'cursor-crosshair'}`}
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
                <div
                  className={`absolute top-2 left-2 px-3 py-1 rounded-full text-xs font-semibold ${
                    eyedropperMode.active
                      ? 'bg-cyan-500 text-white animate-pulse'
                      : drawMode === 'text'
                      ? 'bg-red-500 text-white'
                      : drawMode === 'image-ai'
                      ? 'bg-purple-500 text-white'
                      : 'bg-amber-500 text-white'
                  }`}
                >
                  {eyedropperMode.active 
                    ? `💧 ${eyedropperMode.target === 'text' ? '글자색' : '배경색'} 추출 모드` 
                    : `${modeInfo.icon} ${modeInfo.label}`}
                </div>
                {isProcessing && (
                  <div className="absolute inset-0 bg-white/70 backdrop-blur-sm flex items-center justify-center z-50 rounded-lg">
                    <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col items-center border border-indigo-100">
                      <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                      <p className="font-semibold text-indigo-700">{processStep}</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {resultImage && (
            <div ref={resultRef} className="bg-white p-6 rounded-2xl shadow-lg border-2 border-emerald-400">
              <div className="flex justify-between items-center mb-4 pb-3 border-b border-emerald-100">
                <h3 className="text-xl font-bold text-emerald-800">✨ 결과물</h3>
                <button
                  onClick={downloadResult}
                  className="px-6 py-2 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 transition"
                >
                  다운로드
                </button>
              </div>
              <div className="flex justify-center bg-slate-50 p-4 rounded-xl border border-dashed border-slate-200 overflow-hidden">
                <img src={resultImage} alt="Result" className="max-w-full rounded-lg shadow-lg" />
              </div>
            </div>
          )}
        </section>
      </main>

      <canvas ref={originalCanvasRef} style={{ display: 'none' }} />
      
      {/* 개발자 정보 footer */}
      <footer className="max-w-7xl mx-auto mt-8 pt-6 border-t border-slate-200 text-center text-sm text-slate-500">
        <p>
          개발: <span className="font-semibold text-indigo-600">록신(錄身, Knock Body)</span>
        </p>
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);