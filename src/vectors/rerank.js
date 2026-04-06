import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';

/**
 * Reranks documents using the specified source.
 * @param {string} source - The rerank source (cohere, jina, custom)
 * @param {object} settings - Rerank settings
 * @param {string} settings.model - The rerank model name
 * @param {string} [settings.apiUrl] - Custom API URL (for custom source)
 * @param {string} [settings.apiKey] - Custom API key (for custom source)
 * @param {string} query - The query text
 * @param {Array<{text: string, index: number, hash: number, score?: number}>} documents - Documents to rerank
 * @param {number} topK - Number of top results to return
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @returns {Promise<Array<{text: string, index: number, hash: number, score: number, relevance_score: number}>>} Reranked documents
 */
export async function rerank(source, settings, query, documents, topK, directories) {
 switch (source) {
 case 'cohere':
 return rerankCohere(settings, query, documents, topK, directories);
 case 'jina':
 return rerankJina(settings, query, documents, topK, directories);
 case 'custom':
 return rerankCustom(settings, query, documents, topK);
 default:
 throw new Error(`Unknown rerank source: ${source}`);
 }
}

/**
 * Reranks using Cohere Rerank API v2.
 */
async function rerankCohere(settings, query, documents, topK, directories) {
 const key = readSecret(directories, SECRET_KEYS.COHERE);
 if (!key) {
 throw new Error('No Cohere API key found for reranking');
 }

 const response = await fetch('https://api.cohere.ai/v2/rerank', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${key}`,
 },
 body: JSON.stringify({
 model: settings.model || 'rerank-v3.5',
 query: query,
 documents: documents.map(d => d.text),
 top_n: topK,
 }),
 });

 if (!response.ok) {
 const text = await response.text();
 console.error('Cohere rerank failed:', response.status, text);
 throw new Error(`Cohere rerank failed: ${response.statusText}`);
 }

 const data = await response.json();
 return data.results.map(r => ({
 ...documents[r.index],
 relevance_score: r.relevance_score,
 }));
}

/**
 * Reranks using Jina Rerank API.
 */
async function rerankJina(settings, query, documents, topK, directories) {
 const key = readSecret(directories, SECRET_KEYS.JINA);
 if (!key) {
 throw new Error('No Jina API key found for reranking');
 }

 const response = await fetch('https://api.jina.ai/v1/rerank', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${key}`,
 },
 body: JSON.stringify({
 model: settings.model || 'jina-reranker-v2-base-multilingual',
 query: query,
 documents: documents.map(d => d.text),
 top_n: topK,
 }),
 });

 if (!response.ok) {
 const text = await response.text();
 console.error('Jina rerank failed:', response.status, text);
 throw new Error(`Jina rerank failed: ${response.statusText}`);
 }

 const data = await response.json();
 return data.results.map(r => ({
 ...documents[r.index],
 relevance_score: r.relevance_score,
 }));
}

/**
 * Reranks using a custom OpenAI-compatible rerank endpoint.
 * Expects Cohere-compatible request/response format.
 */
async function rerankCustom(settings, query, documents, topK) {
 if (!settings.apiUrl) {
 throw new Error('No API URL provided for custom reranking');
 }

 const headers = {
 'Content-Type': 'application/json',
 };

 if (settings.apiKey) {
 headers['Authorization'] = `Bearer ${settings.apiKey}`;
 }

 const url = new URL(settings.apiUrl);
 // Append /rerank if the URL doesn't already end with it
 if (!url.pathname.endsWith('/rerank')) {
 url.pathname = url.pathname.replace(/\/$/, '') + '/rerank';
 }

 const response = await fetch(url.toString(), {
 method: 'POST',
 headers: headers,
 body: JSON.stringify({
 model: settings.model || '',
 query: query,
 documents: documents.map(d => d.text),
 top_n: topK,
 }),
 });

 if (!response.ok) {
 const text = await response.text();
 console.error('Custom rerank failed:', response.status, text);
 throw new Error(`Custom rerank failed: ${response.statusText}`);
 }

 const data = await response.json();
 return data.results.map(r => ({
 ...documents[r.index],
 relevance_score: r.relevance_score,
 }));
}
