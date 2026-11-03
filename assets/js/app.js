/* ==========================================================
   Cuéntalo | App web para identificación de patrones
   Autor: Fernando Rosales Tello
   ========================================================== */

"use strict";

(() => {
    // En Vercel y en servidor_local.py la API está en el mismo sitio.
    // GitHub Pages no ejecuta Python, así que desde ahí se usa la API de Vercel,
    // donde está guardada la clave de OpenAI.
    const VERCEL_API_URL = "https://1-3-app-web-para-identificacion-de-zeta.vercel.app/api/Identificador_Imagenes";
    const API_URL = window.location.hostname.endsWith(".github.io")
        ? VERCEL_API_URL
        : "/api/Identificador_Imagenes";

    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
    const MAX_FILE_BYTES = 15 * 1024 * 1024;
    const MIN_DIMENSION = 64;
    const MAX_DIMENSION = 2048;
    // Debe quedar por debajo de MAX_BODY_BYTES en Identificador_Imagenes.py
    const MAX_DATA_URL_CHARS = 3_600_000;
    const MAX_OBJECT_CHARS = 60;
    const REQUEST_TIMEOUT_MS = 75_000;
    const DIGITS = 4;
    // Escala de las coordenadas de ubicaciones en Identificador_Imagenes.py
    const BOX_SCALE = 1000;
    // Lado máximo de la imagen exportada (seguro también en iPhone).
    const MAX_EXPORT_DIMENSION = 3840;
    const MARK_COLOR = "#E5202E";

    const AUTHOR_NAME = "Fernando Rosales Tello";
    const LINKEDIN_URL = "https://www.linkedin.com/in/fernando-rosales-tello-598698349";
    const LINKEDIN_LABEL = "linkedin.com/in/fernando-rosales-tello-598698349";
    // Se carga solo cuando alguien exporta un PDF.
    const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

    // Colores de styles.css para la imagen y el PDF exportados.
    const COLORS = {
        ink: "#14213D",
        inkSoft: "#4E5C77",
        paper: "#F6F8F7",
        line: "#C4CFCC",
        signal: "#FFC83D",
    };
    const REPORT_FONT = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';

    const LOADING_MESSAGES = [
        "Buscando {obj} en la imagen…",
        "Recorriendo la imagen por zonas…",
        "Contando cada ejemplar una sola vez…",
        "Revisando ejemplares parcialmente ocultos…",
    ];

    const $ = (selector) => document.querySelector(selector);

    const els = {
        tray: $("#dropzone"),
        trayBusy: $("#tray-busy"),
        preview: $("#preview"),
        previewImg: $("#preview-img"),
        fileName: $("#file-name"),
        fileMeta: $("#file-meta"),
        fileInput: $("#file-input"),
        cameraInput: $("#camera-input"),
        btnBrowse: $("#btn-browse"),
        btnCamera: $("#btn-camera"),
        btnExport: $("#btn-export"),
        btnExportPdf: $("#btn-export-pdf"),
        btnChange: $("#btn-change"),
        btnRemove: $("#btn-remove"),
        stepImage: $("#step-image"),
        stepObject: $("#step-object"),
        stepCount: $("#step-count"),
        imageStatus: $("#image-status"),
        objectInput: $("#object-input"),
        suggestions: $("#suggestions"),
        btnCount: $("#btn-count"),
        btnCountLabel: $("#btn-count-label"),
        alert: $("#alert"),
        alertTitle: $("#alert-title"),
        alertText: $("#alert-text"),
        alertClose: $("#alert-close"),
        result: $("#result"),
        resultEmoji: $("#result-emoji"),
        resultLabel: $("#result-label"),
        counter: $("#counter"),
        counterWindow: $("#counter-window"),
        resultSentence: $("#result-sentence"),
        resultDetails: $("#result-details"),
        confidence: $("#confidence"),
        confidenceText: $("#confidence-text"),
        explanation: $("#result-explanation"),
        warnings: $("#result-warnings"),
        others: $("#others"),
        othersList: $("#others-list"),
        live: $("#live"),
    };

    const state = {
        dataUrl: null,
        previewUrl: null,
        image: null,
        fileName: "",
        annotatedUrl: null,
        annotatedName: "",
        annotatedCanvas: null,
        annotatedResult: null,
        annotationId: 0,
        exporting: false,
        busy: false,
        preparing: false,
        loadingTimer: null,
    };

    /* ---------- Utilidades ---------- */

    class UserError extends Error {
        constructor(title, detail) {
            super(title);
            this.title = title;
            this.detail = detail;
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024 * 1024) {
            return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function capitalize(text) {
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    }

    // Solo quita espacios sobrantes. La limpieza completa del texto
    // (signos, "cuántos hay…", etc.) se hace en Identificador_Imagenes.py.
    function normalizeObject(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isTouchDevice() {
        return window.matchMedia("(pointer: coarse)").matches;
    }

    /* ---------- Mensajes de error ---------- */

    function showAlert(title, detail) {
        els.alertTitle.textContent = title;
        els.alertText.textContent = detail || "";
        els.alert.hidden = false;
    }

    function hideAlert() {
        els.alert.hidden = true;
        els.objectInput.removeAttribute("aria-invalid");
    }

    function nudgeTray() {
        els.tray.dataset.attention = "false";
        void els.tray.offsetWidth;
        els.tray.dataset.attention = "true";
        window.setTimeout(() => {
            els.tray.dataset.attention = "false";
        }, 700);
    }

    /* ---------- Contador mecánico ---------- */

    function buildCounter() {
        const fragment = document.createDocumentFragment();

        for (let i = 0; i < DIGITS; i += 1) {
            const digit = document.createElement("span");
            digit.className = "digit is-lead";

            const strip = document.createElement("span");
            strip.className = "digit-strip";
            strip.style.setProperty("--speed", `${0.55 + i * 0.18}s`);

            // 0 al 9 más un 0 extra para que el giro continuo sea fluido.
            for (let n = 0; n <= 10; n += 1) {
                const cell = document.createElement("span");
                cell.textContent = String(n % 10);
                strip.appendChild(cell);
            }

            digit.appendChild(strip);
            fragment.appendChild(digit);
        }

        els.counterWindow.replaceChildren(fragment);
    }

    function setCounter(value, animate = true) {
        const safeValue = Math.max(0, Math.min(value, 10 ** DIGITS - 1));
        const text = String(safeValue).padStart(DIGITS, "0");
        const firstSignificant = safeValue === 0 ? DIGITS - 1 : DIGITS - String(safeValue).length;
        const digits = els.counterWindow.querySelectorAll(".digit");

        els.counter.dataset.spinning = "false";

        digits.forEach((digit, index) => {
            const strip = digit.firstElementChild;
            digit.classList.toggle("is-lead", index < firstSignificant || (safeValue === 0 && !animate));
            strip.style.setProperty("--delay", animate ? `${index * 110}ms` : "0ms");
            strip.style.setProperty("--d", "0");
        });

        // Forzamos un reflow para que la animación arranque desde cero.
        void els.counterWindow.offsetWidth;

        digits.forEach((digit, index) => {
            digit.firstElementChild.style.setProperty("--d", text[index]);
        });
    }

    function spinCounter() {
        els.counterWindow.querySelectorAll(".digit").forEach((digit) => {
            digit.classList.remove("is-lead");
        });
        els.counter.dataset.spinning = "true";
    }

    /* ---------- Pasos y estado de la interfaz ---------- */

    function updateSteps() {
        const object = normalizeObject(els.objectInput.value);

        els.stepImage.dataset.done = String(Boolean(state.dataUrl));
        els.stepObject.dataset.done = String(Boolean(object));

        els.btnCountLabel.textContent = object && object.length <= MAX_OBJECT_CHARS
            ? `Contar ${object.toLowerCase()}`
            : "Contar objetos";

        els.suggestions.querySelectorAll(".chip").forEach((chip) => {
            const pressed = chip.dataset.object === object.toLowerCase();
            chip.setAttribute("aria-pressed", String(pressed));
        });
    }

    function setBusy(busy) {
        state.busy = busy;

        els.btnCount.disabled = busy;
        els.btnCount.setAttribute("aria-busy", String(busy));
        els.objectInput.disabled = busy;
        els.btnExport.disabled = busy;
        els.btnExportPdf.disabled = busy;
        els.btnChange.disabled = busy;
        els.btnRemove.disabled = busy;
        els.tray.dataset.scanning = String(busy);

        document.querySelectorAll(".chip").forEach((chip) => {
            chip.disabled = busy;
        });

        if (busy) {
            els.btnCountLabel.textContent = "Contando…";
        } else {
            updateSteps();
        }
    }

    function stopLoadingMessages() {
        window.clearInterval(state.loadingTimer);
        state.loadingTimer = null;
    }

    function startLoadingMessages(object) {
        let index = 0;
        const render = () => {
            els.resultSentence.textContent = LOADING_MESSAGES[index].replace("{obj}", object);
            index = (index + 1) % LOADING_MESSAGES.length;
        };

        stopLoadingMessages();
        render();
        state.loadingTimer = window.setInterval(render, 2600);
    }

    /* ---------- Imagen con los objetos marcados ---------- */

    function clearAnnotation() {
        // Invalida cualquier imagen marcada que todavía se esté generando.
        state.annotationId += 1;

        if (state.annotatedUrl) {
            URL.revokeObjectURL(state.annotatedUrl);
        }

        state.annotatedUrl = null;
        state.annotatedName = "";
        state.annotatedCanvas = null;
        state.annotatedResult = null;
        els.btnExport.hidden = true;
        els.btnExportPdf.hidden = true;

        if (state.previewUrl) {
            els.previewImg.src = state.previewUrl;
            els.previewImg.alt = `Vista previa de ${state.fileName || "la imagen cargada"}`;
        }
    }

    function slugify(text) {
        return text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "objetos";
    }

    // Dibuja la imagen original con un círculo rojo alrededor de cada objeto.
    function drawAnnotation(img, locations) {
        const scale = Math.min(1, MAX_EXPORT_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.fillStyle = "#FFFFFF";
        context.fillRect(0, 0, width, height);
        context.drawImage(img, 0, 0, width, height);

        const lineWidth = Math.max(3, Math.round(Math.max(width, height) * 0.004));

        locations.forEach((box) => {
            const left = (box.x_min / BOX_SCALE) * width;
            const right = (box.x_max / BOX_SCALE) * width;
            const top = (box.y_min / BOX_SCALE) * height;
            const bottom = (box.y_max / BOX_SCALE) * height;
            const radius = (Math.max(right - left, bottom - top) / 2) * 1.12 + lineWidth;

            context.beginPath();
            context.arc((left + right) / 2, (top + bottom) / 2, radius, 0, Math.PI * 2);

            // Un borde blanco debajo del rojo para que se vea sobre fondos rojos.
            context.strokeStyle = "rgba(255, 255, 255, 0.85)";
            context.lineWidth = lineWidth * 1.8;
            context.stroke();

            context.strokeStyle = MARK_COLOR;
            context.lineWidth = lineWidth;
            context.stroke();
        });

        return canvas;
    }

    function canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob"))), type, quality);
        });
    }

    async function showAnnotation(result) {
        if (!state.image || result.ubicaciones.length === 0) {
            return;
        }

        const id = state.annotationId;
        let canvas;
        let blob;

        try {
            canvas = drawAnnotation(state.image, result.ubicaciones);
            blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
        } catch {
            return;
        }

        // Si mientras se generaba se cambió la imagen o empezó otro conteo.
        if (id !== state.annotationId) {
            return;
        }

        const plural = result.objeto_plural || result.objeto_solicitado;

        state.annotatedUrl = URL.createObjectURL(blob);
        state.annotatedName = `cuentalo-${slugify(plural)}`;
        state.annotatedCanvas = canvas;
        state.annotatedResult = result;
        els.previewImg.src = state.annotatedUrl;
        els.previewImg.alt = `Imagen con ${result.ubicaciones.length} ${result.ubicaciones.length === 1 ? result.objeto_singular : plural} marcados con un círculo rojo`;
        els.btnExport.hidden = false;
        els.btnExportPdf.hidden = false;
    }

    /* ---------- Exportar imagen y PDF ---------- */

    // Datos del conteo que se escriben en la imagen y en el PDF.
    function buildSummary(result) {
        const [lead, strong] = buildSentence(result);
        const marked = result.ubicaciones.length;
        const plural = result.objeto_plural || result.objeto_solicitado;

        return {
            date: new Date().toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" }),
            searched: result.objeto_solicitado,
            found: strong ? `${lead}${strong}.` : lead,
            marked: marked === result.cantidad
                ? ""
                : `En la imagen se marcaron ${marked} ${marked === 1 ? result.objeto_singular : plural}.`,
            confidence: `Confianza ${result.confianza}`,
            explanation: result.explicacion || "",
            warnings: result.advertencias,
            others: result.otros_objetos.length ? `También se ven: ${result.otros_objetos.join(", ")}.` : "",
        };
    }

    function wrapText(context, text, maxWidth) {
        const lines = [];
        let line = "";

        text.split(" ").forEach((word) => {
            const candidate = line ? `${line} ${word}` : word;
            if (line && context.measureText(candidate).width > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = candidate;
            }
        });

        if (line) {
            lines.push(line);
        }
        return lines;
    }

    // Agrega debajo de la imagen marcada una franja con la descripción
    // del conteo y los datos de contacto.
    async function composeReportImage(annotated, summary) {
        const width = annotated.width;
        const base = Math.round(Math.min(Math.max(width / 55, 14), 44));
        const pad = Math.round(base * 1.6);
        const maxTextWidth = width - pad * 2;
        const font = (weight, size) => `${weight} ${size}px ${REPORT_FONT}`;

        try {
            await document.fonts.load(font(800, base));
        } catch {
            // Si la fuente no carga se usa la del sistema.
        }

        const measure = document.createElement("canvas").getContext("2d");
        const rows = [];
        const add = (text, { weight = 400, size = base, color = COLORS.inkSoft, gap = 0 } = {}) => {
            if (!text) {
                return;
            }
            measure.font = font(weight, size);
            wrapText(measure, text, maxTextWidth).forEach((line, index) => {
                rows.push({ line, weight, size, color, gap: index === 0 ? gap : 0 });
            });
        };

        add("Cuéntalo · Conteo de objetos con IA", { weight: 800, size: Math.round(base * 1.35), color: COLORS.ink });
        add(summary.date, { size: Math.round(base * 0.85) });
        add(`Objeto buscado: ${summary.searched}`, { weight: 700, color: COLORS.ink, gap: base * 0.8 });
        add(summary.found, { weight: 700, color: COLORS.ink });
        add(summary.marked);
        add(summary.confidence);
        add(summary.explanation, { gap: base * 0.5 });
        summary.warnings.forEach((warning) => add(`• ${warning}`));
        add(summary.others);
        rows.push({ divider: true, gap: base * 0.9 });
        add(`Proyecto de ${AUTHOR_NAME}. ¿Quieres un proyecto similar? Contáctame en LinkedIn:`, { gap: base * 0.9 });
        add(LINKEDIN_LABEL, { weight: 700, color: COLORS.ink });

        const lineHeight = (row) => (row.divider ? 1 : row.size * 1.35);
        const bandHeight = Math.ceil(pad * 2 + rows.reduce((sum, row) => sum + row.gap + lineHeight(row), 0));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = annotated.height + bandHeight;

        const context = canvas.getContext("2d");
        context.drawImage(annotated, 0, 0);
        context.fillStyle = COLORS.paper;
        context.fillRect(0, annotated.height, width, bandHeight);
        context.fillStyle = COLORS.signal;
        context.fillRect(0, annotated.height, width, Math.max(4, Math.round(base * 0.3)));

        context.textBaseline = "top";
        let y = annotated.height + pad;

        rows.forEach((row) => {
            y += row.gap;
            if (row.divider) {
                context.fillStyle = COLORS.line;
                context.fillRect(pad, y, maxTextWidth, Math.max(1, Math.round(base / 14)));
            } else {
                context.font = font(row.weight, row.size);
                context.fillStyle = row.color;
                context.fillText(row.line, pad, y);
            }
            y += lineHeight(row);
        });

        return canvas;
    }

    function downloadBlob(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    let jsPdfPromise = null;

    function loadJsPdf() {
        if (window.jspdf) {
            return Promise.resolve(window.jspdf.jsPDF);
        }

        if (!jsPdfPromise) {
            jsPdfPromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = JSPDF_URL;
                script.async = true;
                script.onload = () => (window.jspdf ? resolve(window.jspdf.jsPDF) : reject(new Error("jspdf")));
                script.onerror = () => {
                    jsPdfPromise = null;
                    script.remove();
                    reject(new UserError("No se pudo crear el PDF", "Revisa tu conexión a internet e intenta de nuevo."));
                };
                document.head.appendChild(script);
            });
        }

        return jsPdfPromise;
    }

    // Las fuentes estándar del PDF solo cubren el alfabeto latino básico.
    function pdfSafe(text) {
        return String(text || "")
            .replace(/[“”«»]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[–—]/g, "-")
            .replace(/…/g, "...")
            .replace(/[^\x20-\xFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    async function buildPdf(annotated, summary) {
        const JsPDF = await loadJsPdf();
        const doc = new JsPDF({ unit: "mm", format: "a4" });

        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 16;
        const contentWidth = pageWidth - margin * 2;
        const bottom = pageHeight - margin - 14;
        const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        let y = margin + 4;

        const paragraph = (text, { size = 11, style = "normal", color = COLORS.inkSoft, gap = 0 } = {}) => {
            const clean = pdfSafe(text);
            if (!clean) {
                return;
            }
            y += gap;
            doc.setFont("helvetica", style);
            doc.setFontSize(size);
            doc.setTextColor(...rgb(color));

            const lineHeight = size * 0.3528 * 1.4;
            doc.splitTextToSize(clean, contentWidth).forEach((line) => {
                if (y + lineHeight > bottom) {
                    doc.addPage();
                    y = margin;
                }
                doc.text(line, margin, y, { baseline: "top" });
                y += lineHeight;
            });
        };

        doc.setFillColor(...rgb(COLORS.signal));
        doc.rect(0, 0, pageWidth, 4, "F");

        paragraph("Cuéntalo", { size: 22, style: "bold", color: COLORS.ink });
        paragraph("Resultado del conteo de objetos con IA", { size: 12 });
        paragraph(summary.date, { size: 10 });

        paragraph(`Objeto buscado: ${summary.searched}`, { size: 13, style: "bold", color: COLORS.ink, gap: 6 });
        paragraph(summary.found, { size: 13, style: "bold", color: COLORS.ink });
        paragraph(summary.marked);
        paragraph(summary.confidence);
        paragraph(summary.explanation, { gap: 3 });
        summary.warnings.forEach((warning) => paragraph(`- ${warning}`));
        paragraph(summary.others);

        // Imagen con los objetos marcados, ajustada al espacio disponible.
        const ratio = annotated.height / annotated.width;
        y += 6;
        if (bottom - y < 70) {
            doc.addPage();
            y = margin;
        }
        let imageWidth = contentWidth;
        let imageHeight = imageWidth * ratio;
        if (imageHeight > bottom - y) {
            imageHeight = bottom - y;
            imageWidth = imageHeight / ratio;
        }
        const imageX = margin + (contentWidth - imageWidth) / 2;
        doc.addImage(annotated.toDataURL("image/jpeg", 0.88), "JPEG", imageX, y, imageWidth, imageHeight);
        doc.setDrawColor(...rgb(COLORS.line));
        doc.rect(imageX, y, imageWidth, imageHeight, "S");

        // Pie con los datos de contacto en cada página.
        const pages = doc.getNumberOfPages();
        for (let page = 1; page <= pages; page += 1) {
            doc.setPage(page);
            doc.setDrawColor(...rgb(COLORS.line));
            doc.line(margin, pageHeight - margin - 9, pageWidth - margin, pageHeight - margin - 9);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(9);
            doc.setTextColor(...rgb(COLORS.inkSoft));
            doc.text(pdfSafe(`Proyecto de ${AUTHOR_NAME}. ¿Quieres un proyecto similar? Contáctame en LinkedIn:`), margin, pageHeight - margin - 4);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(...rgb(COLORS.ink));
            doc.textWithLink(LINKEDIN_LABEL, margin, pageHeight - margin + 1, { url: LINKEDIN_URL });
        }

        return doc.output("blob");
    }

    async function exportReport(format) {
        if (!state.annotatedCanvas || state.exporting || state.busy) {
            return;
        }

        const id = state.annotationId;
        const canvas = state.annotatedCanvas;
        const summary = buildSummary(state.annotatedResult);
        const fileName = state.annotatedName;

        state.exporting = true;
        els.btnExport.disabled = true;
        els.btnExportPdf.disabled = true;
        hideAlert();

        try {
            const blob = format === "pdf"
                ? await buildPdf(canvas, summary)
                : await canvasToBlob(await composeReportImage(canvas, summary), "image/jpeg", 0.92);

            // Si mientras se generaba se cambió la imagen o empezó otro conteo.
            if (id === state.annotationId) {
                downloadBlob(blob, `${fileName}.${format === "pdf" ? "pdf" : "jpg"}`);
            }
        } catch (error) {
            if (error instanceof UserError) {
                showAlert(error.title, error.detail);
            } else {
                showAlert("No se pudo exportar", "Ocurrió un problema al generar el archivo. Intenta de nuevo.");
            }
        } finally {
            state.exporting = false;
            els.btnExport.disabled = state.busy;
            els.btnExportPdf.disabled = state.busy;
        }
    }

    function resetResult() {
        stopLoadingMessages();
        clearAnnotation();
        els.result.dataset.state = "idle";
        els.resultEmoji.textContent = "";
        els.resultLabel.textContent = "Resultado";
        els.resultSentence.textContent = "El conteo aparecerá aquí cuando termine el análisis.";
        els.resultDetails.hidden = true;
        els.stepCount.dataset.done = "false";
        setCounter(0, false);
    }

    /* ---------- Carga de imágenes ---------- */

    function validateFile(file) {
        if (!file) {
            return new UserError("No se seleccionó ninguna imagen", "Elige o arrastra una imagen para continuar.");
        }

        const type = (file.type || "").toLowerCase();
        const hasValidExtension = ALLOWED_EXTENSIONS.test(file.name || "");

        if (type && !type.startsWith("image/")) {
            return new UserError("El archivo no es una imagen", `"${file.name}" no es una imagen. Elige una foto JPG, PNG o WEBP.`);
        }

        if ((type && !ALLOWED_TYPES.includes(type)) || (!type && !hasValidExtension)) {
            return new UserError("Formato no compatible", "Usa una imagen JPG, PNG o WEBP. Si tu foto es HEIC, conviértela o haz una captura de pantalla.");
        }

        if (file.size === 0) {
            return new UserError("El archivo está vacío", "Elige otra imagen.");
        }

        if (file.size > MAX_FILE_BYTES) {
            return new UserError("La imagen es demasiado grande", `Pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(MAX_FILE_BYTES)}. Usa una imagen más ligera.`);
        }

        return null;
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new UserError("No se pudo leer la imagen", "El archivo puede estar dañado o no ser una imagen real. Prueba con otra."));
            img.src = url;
        });
    }

    function encodeImage(img, maxDimension, quality) {
        const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.fillStyle = "#FFFFFF";
        context.fillRect(0, 0, width, height);
        context.drawImage(img, 0, 0, width, height);

        return { dataUrl: canvas.toDataURL("image/jpeg", quality), width, height };
    }

    // Redimensiona y comprime la imagen para respetar el límite de 4.5 MB de Vercel.
    function compressImage(img) {
        let maxDimension = MAX_DIMENSION;
        let quality = 0.9;
        let encoded = encodeImage(img, maxDimension, quality);

        for (let attempt = 0; encoded.dataUrl.length > MAX_DATA_URL_CHARS && attempt < 10; attempt += 1) {
            if (quality > 0.65) {
                quality -= 0.1;
            } else {
                maxDimension = Math.round(maxDimension * 0.8);
            }
            encoded = encodeImage(img, maxDimension, quality);
        }

        if (!encoded.dataUrl.startsWith("data:image/jpeg") || encoded.dataUrl.length > MAX_DATA_URL_CHARS) {
            throw new UserError("No se pudo preparar la imagen", "Prueba con una imagen de menor resolución.");
        }

        return encoded;
    }

    async function handleFile(file) {
        if (state.busy || state.preparing) {
            return;
        }

        hideAlert();

        const problem = validateFile(file);
        if (problem) {
            showAlert(problem.title, problem.detail);
            return;
        }

        state.preparing = true;
        els.trayBusy.hidden = false;

        const url = URL.createObjectURL(file);

        try {
            const img = await loadImage(url);

            if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_DIMENSION) {
                throw new UserError("La imagen es demasiado pequeña", `Mide ${img.naturalWidth} × ${img.naturalHeight} px. Usa una imagen de al menos ${MIN_DIMENSION} px por lado.`);
            }

            const encoded = compressImage(img);

            if (state.previewUrl) {
                URL.revokeObjectURL(state.previewUrl);
            }

            state.previewUrl = url;
            state.dataUrl = encoded.dataUrl;
            state.image = img;
            state.fileName = file.name || "";

            els.previewImg.src = url;
            els.previewImg.alt = `Vista previa de ${file.name || "la imagen cargada"}`;
            els.fileName.textContent = file.name || "Imagen pegada";
            els.fileMeta.textContent = `${img.naturalWidth} × ${img.naturalHeight} px, ${formatBytes(file.size)}`;
            els.preview.hidden = false;
            els.tray.dataset.state = "loaded";

            els.imageStatus.innerHTML = "";
            const name = document.createElement("strong");
            name.textContent = file.name || "Imagen pegada";
            els.imageStatus.append(name, " está lista para analizar.");

            resetResult();
            updateSteps();

            if (!isTouchDevice() && !normalizeObject(els.objectInput.value)) {
                els.objectInput.focus();
            }
        } catch (error) {
            URL.revokeObjectURL(url);
            if (error instanceof UserError) {
                showAlert(error.title, error.detail);
            } else {
                showAlert("No se pudo cargar la imagen", "Prueba con otra imagen JPG, PNG o WEBP.");
            }
        } finally {
            state.preparing = false;
            els.trayBusy.hidden = true;
            els.fileInput.value = "";
            els.cameraInput.value = "";
        }
    }

    function removeImage() {
        if (state.busy) {
            return;
        }

        if (state.previewUrl) {
            URL.revokeObjectURL(state.previewUrl);
        }

        state.previewUrl = null;
        state.dataUrl = null;
        state.image = null;
        state.fileName = "";
        els.previewImg.removeAttribute("src");
        els.preview.hidden = true;
        els.tray.dataset.state = "empty";
        els.imageStatus.textContent = "Todavía no hay ninguna imagen cargada.";

        hideAlert();
        resetResult();
        updateSteps();
        els.btnBrowse.focus();
    }

    function openPicker() {
        if (!state.busy && !state.preparing) {
            els.fileInput.click();
        }
    }

    /* ---------- Conteo con IA ---------- */

    function messageForStatus(status) {
        if (status === 413) {
            return ["La imagen es demasiado pesada", "Usa una imagen más ligera o de menor resolución."];
        }
        if (status === 404 || status === 405 || status === 501) {
            return ["No se encontró el servicio de análisis", "Abre la app con python servidor_local.py, vercel dev o desde tu sitio en Vercel."];
        }
        if (status === 429) {
            return ["Demasiadas solicitudes", "Espera un momento e intenta de nuevo."];
        }
        if (status === 504) {
            return ["El análisis tardó demasiado", "Intenta de nuevo o usa una imagen más sencilla."];
        }
        return ["No se pudo completar el análisis", "Ocurrió un error al procesar la imagen. Intenta de nuevo."];
    }

    function validateResult(payload) {
        const result = payload && payload.resultado;

        const valid = result
            && typeof result === "object"
            && Number.isInteger(result.cantidad)
            && result.cantidad >= 0
            && typeof result.objeto_plural === "string"
            && typeof result.objeto_singular === "string";

        if (!valid) {
            throw new UserError("Respuesta inesperada de la IA", "El resultado no llegó en el formato esperado. Intenta de nuevo.");
        }

        return {
            ...result,
            advertencias: Array.isArray(result.advertencias) ? result.advertencias : [],
            otros_objetos: Array.isArray(result.otros_objetos) ? result.otros_objetos : [],
            ubicaciones: Array.isArray(result.ubicaciones)
                ? result.ubicaciones.filter((box) => box && ["x_min", "y_min", "x_max", "y_max"].every((key) => Number.isFinite(box[key])))
                : [],
        };
    }

    function buildSentence(result) {
        const count = result.cantidad;
        const singular = result.objeto_singular || result.objeto_plural;
        const plural = result.objeto_plural || singular;

        if (!result.es_objeto_contable) {
            return [`No se puede contar "${result.objeto_solicitado}" en una imagen.`, null];
        }
        if (count === 0) {
            return [`No se encontraron ${plural} en esta imagen.`, null];
        }
        if (count === 1) {
            return ["Se encontró ", `1 ${singular}`];
        }
        return ["Se encontraron ", `${count} ${plural}`];
    }

    function renderResult(result) {
        const count = result.cantidad;
        const plural = result.objeto_plural || result.objeto_solicitado;
        const feminine = result.genero === "femenino";

        let status = "done";
        if (!result.es_objeto_contable) {
            status = "notice";
        } else if (count === 0) {
            status = "empty";
        }

        els.result.dataset.state = status;
        els.resultEmoji.textContent = result.emoji || "";

        if (status === "notice") {
            els.resultLabel.textContent = "No es un objeto contable";
        } else {
            const participle = count === 1 ? (feminine ? "detectada" : "detectado") : (feminine ? "detectadas" : "detectados");
            const label = count === 1 ? result.objeto_singular : plural;
            els.resultLabel.textContent = `${capitalize(label)} ${participle}`;
        }

        const [lead, strong] = buildSentence(result);
        els.resultSentence.replaceChildren();
        if (strong) {
            const emphasis = document.createElement("strong");
            emphasis.textContent = strong;
            els.resultSentence.append(lead, emphasis, ".");
        } else {
            els.resultSentence.textContent = lead;
        }

        setCounter(count, true);

        // Confianza
        const levels = { alta: "Confianza alta", media: "Confianza media", baja: "Confianza baja" };
        const level = levels[result.confianza] ? result.confianza : "baja";
        els.confidence.dataset.level = level;
        els.confidenceText.textContent = levels[level];
        els.confidence.hidden = status === "notice";

        els.explanation.textContent = result.explicacion || "";

        els.warnings.replaceChildren(...result.advertencias.map((text) => {
            const item = document.createElement("li");
            item.textContent = text;
            return item;
        }));

        els.othersList.replaceChildren(...result.otros_objetos.map((name) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip chip-count";
            chip.dataset.object = name;
            chip.textContent = `Contar ${name}`;
            return chip;
        }));
        els.others.hidden = result.otros_objetos.length === 0;

        els.resultDetails.hidden = false;
        els.stepCount.dataset.done = String(status === "done" || status === "empty");
        els.live.textContent = els.resultSentence.textContent;

        if (status === "done") {
            showAnnotation(result);
        }
    }

    async function runCount(objectOverride) {
        if (state.busy || state.preparing) {
            return;
        }

        hideAlert();

        if (typeof objectOverride === "string") {
            els.objectInput.value = objectOverride;
            updateSteps();
        }

        const object = normalizeObject(els.objectInput.value);

        if (!state.dataUrl) {
            showAlert("Falta la imagen", "Sube una imagen antes de iniciar el conteo.");
            nudgeTray();
            return;
        }

        if (!object) {
            showAlert("Falta el objeto a contar", "Escribe qué objeto deseas contar, por ejemplo: manzanas.");
            els.objectInput.setAttribute("aria-invalid", "true");
            els.objectInput.focus();
            return;
        }

        if (object.length > MAX_OBJECT_CHARS) {
            showAlert("El nombre es demasiado largo", `Escribe el objeto en ${MAX_OBJECT_CHARS} caracteres o menos.`);
            els.objectInput.setAttribute("aria-invalid", "true");
            els.objectInput.focus();
            return;
        }

        setBusy(true);
        clearAnnotation();
        els.result.dataset.state = "loading";
        els.resultEmoji.textContent = "";
        els.resultLabel.textContent = `Contando ${object.toLowerCase()}`;
        els.resultDetails.hidden = true;
        els.stepCount.dataset.done = "false";
        spinCounter();
        startLoadingMessages(object.toLowerCase());
        els.live.textContent = `Analizando la imagen para contar ${object}.`;

        if (window.matchMedia("(max-width: 959px)").matches) {
            els.result.scrollIntoView({ behavior: "smooth", block: "center" });
        }

        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            let response;

            try {
                response = await fetch(API_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ image: state.dataUrl, object }),
                    signal: controller.signal,
                });
            } catch (networkError) {
                if (networkError.name === "AbortError") {
                    throw new UserError("El análisis tardó demasiado", "La IA no respondió a tiempo. Intenta de nuevo o usa una imagen más sencilla.");
                }
                if (API_URL !== VERCEL_API_URL) {
                    throw new UserError("Sin conexión con el servidor", "Revisa tu conexión a internet e intenta de nuevo.");
                }
                throw new UserError(
                    "No se pudo conectar con el servicio de análisis",
                    `Revisa tu conexión a internet. Si el problema continúa, el servidor en Vercel debe autorizar la dirección ${window.location.origin} en ALLOWED_ORIGIN.`
                );
            }

            let payload = null;
            try {
                payload = await response.json();
            } catch {
                payload = null;
            }

            if (!response.ok) {
                const [title, detail] = messageForStatus(response.status);
                const serverMessage = payload && typeof payload.error === "string" ? payload.error : null;
                throw new UserError(serverMessage ? "No se pudo completar el análisis" : title, serverMessage || detail);
            }

            stopLoadingMessages();
            renderResult(validateResult(payload));
        } catch (error) {
            stopLoadingMessages();
            resetResult();

            if (error instanceof UserError) {
                showAlert(error.title, error.detail);
            } else {
                showAlert("Error de procesamiento", "Ocurrió un problema inesperado. Intenta de nuevo.");
            }

            els.live.textContent = els.alertTitle.textContent;
        } finally {
            window.clearTimeout(timer);
            setBusy(false);
        }
    }

    /* ---------- Eventos ---------- */

    els.btnBrowse.addEventListener("click", (event) => {
        event.stopPropagation();
        openPicker();
    });

    els.btnCamera.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!state.busy && !state.preparing) {
            els.cameraInput.click();
        }
    });

    els.btnExport.addEventListener("click", () => exportReport("image"));
    els.btnExportPdf.addEventListener("click", () => exportReport("pdf"));
    els.btnChange.addEventListener("click", openPicker);
    els.btnRemove.addEventListener("click", removeImage);

    els.tray.addEventListener("click", (event) => {
        if (els.tray.dataset.state === "empty" && !event.target.closest("button")) {
            openPicker();
        }
    });

    els.fileInput.addEventListener("change", () => handleFile(els.fileInput.files[0]));
    els.cameraInput.addEventListener("change", () => handleFile(els.cameraInput.files[0]));

    // Arrastrar y soltar
    let dragDepth = 0;
    const previousTrayState = () => (state.dataUrl ? "loaded" : "empty");

    els.tray.addEventListener("dragenter", (event) => {
        event.preventDefault();
        if (state.busy) {
            return;
        }
        dragDepth += 1;
        els.tray.dataset.drag = "true";
        if (!state.dataUrl) {
            els.tray.dataset.state = "dragover";
        }
    });

    els.tray.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = state.busy ? "none" : "copy";
        }
    });

    els.tray.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            els.tray.dataset.drag = "false";
            els.tray.dataset.state = previousTrayState();
        }
    });

    els.tray.addEventListener("drop", (event) => {
        event.preventDefault();
        dragDepth = 0;
        els.tray.dataset.drag = "false";
        els.tray.dataset.state = previousTrayState();

        if (state.busy) {
            return;
        }

        const files = event.dataTransfer ? event.dataTransfer.files : null;
        if (!files || files.length === 0) {
            showAlert("No se recibió ninguna imagen", "Arrastra un archivo de imagen desde tu equipo.");
            return;
        }
        handleFile(files[0]);
    });

    // Evita que el navegador abra la imagen si se suelta fuera de la bandeja.
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());

    // Pegar una imagen con Ctrl + V
    document.addEventListener("paste", (event) => {
        const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
        const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));

        if (!imageItem) {
            return;
        }

        event.preventDefault();
        const blob = imageItem.getAsFile();
        if (!blob) {
            return;
        }
        const extension = blob.type.split("/")[1] || "png";
        const file = new File([blob], `imagen-pegada.${extension}`, { type: blob.type });
        handleFile(file);
    });

    // Objeto a contar
    els.objectInput.addEventListener("input", () => {
        els.objectInput.removeAttribute("aria-invalid");
        updateSteps();
    });

    els.objectInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            runCount();
        }
    });

    els.suggestions.addEventListener("click", (event) => {
        const chip = event.target.closest(".chip");
        if (!chip || state.busy) {
            return;
        }
        els.objectInput.value = chip.dataset.object;
        els.objectInput.removeAttribute("aria-invalid");
        updateSteps();
        if (!isTouchDevice()) {
            els.objectInput.focus();
        }
    });

    els.othersList.addEventListener("click", (event) => {
        const chip = event.target.closest(".chip");
        if (chip && !state.busy) {
            runCount(chip.dataset.object);
        }
    });

    els.btnCount.addEventListener("click", () => runCount());
    els.alertClose.addEventListener("click", hideAlert);

    /* ---------- Inicio ---------- */

    buildCounter();
    resetResult();
    updateSteps();

    if (window.location.protocol === "file:") {
        showAlert(
            "Abre la app desde un servidor",
            "Al abrir index.html con doble clic no se puede consultar la IA. Ejecuta python servidor_local.py y entra a http://localhost:8000."
        );
    }
})();