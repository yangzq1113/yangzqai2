import { html as diff2htmlHtml } from 'diff2html';
import { isProbablyReaderable, Readability } from '@mozilla/readability';

const optionalBundle = {
    diff2htmlHtml,
    isProbablyReaderable,
    Readability,
    initialized: true,
};

export {
    diff2htmlHtml,
    isProbablyReaderable,
    Readability,
};

export default optionalBundle;
