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

    function normalizeObject(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^[¿¡"'.,:;]+|[?!"'.,:;]+$/g, "")
            .replace(/^(contar|cuenta|cu[eé]ntame|cu[aá]nt[oa]s)\s+(hay\s+)?(de\s+)?((los|las|el|la)\s+)?/i, "")
            .replace(/\s+hay(\s+en\s+la\s+(imagen|foto))?$/i, "")
            .trim();
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

    function resetResult() {
        stopLoadingMessages();
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