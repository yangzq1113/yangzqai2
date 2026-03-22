function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function updateCharacterJsonData(jsonDataText, boundPreset) {
    const jsonData = JSON.parse(String(jsonDataText || ''));
    jsonData.data = isPlainObject(jsonData.data) ? jsonData.data : {};
    jsonData.data.extensions = isPlainObject(jsonData.data.extensions) ? jsonData.data.extensions : {};
    jsonData.data.extensions.luker = isPlainObject(jsonData.data.extensions.luker) ? jsonData.data.extensions.luker : {};
    jsonData.data.extensions.luker.chat_completion_preset = boundPreset;
    return JSON.stringify(jsonData);
}

self.addEventListener('message', (event) => {
    const id = Number(event?.data?.id);
    if (!Number.isInteger(id)) {
        return;
    }

    try {
        const jsonData = updateCharacterJsonData(event?.data?.jsonData, event?.data?.boundPreset ?? null);
        self.postMessage({ id, ok: true, jsonData });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
});
