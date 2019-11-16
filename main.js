const Apify = require('apify');
const url = require('url');
const querystring = require('querystring');
const _ = require('underscore');
const safeEval = require('safe-eval');

const { log } = Apify.utils;
log.setLevel(log.LEVELS.WARNING);

function delay(time) {
    return new Promise(((resolve) => {
        setTimeout(resolve, time);
    }));
}

const isObject = val => typeof val === 'object' && val !== null && !Array.isArray(val);

let detailsEnqueued = 0;

Apify.events.on('migrating', async () => {
    await Apify.setValue('detailsEnqueued', detailsEnqueued);
});

Apify.main(async () => {
    const input = await Apify.getInput();
    console.log('Input:');
    console.dir(input);

    if (!input || !Array.isArray(input.startUrls) || input.startUrls.length === 0) {
        throw new Error("Invalid input, it needs to contain at least one url in 'startUrls'.");
    }

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            extendOutputFunction = safeEval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    const requestQueue = await Apify.openRequestQueue();

    detailsEnqueued = await Apify.getValue('detailsEnqueued');
    if (!detailsEnqueued) {
        detailsEnqueued = 0;
    }

    function checkLimit() {
        return input.maxItems && detailsEnqueued >= input.maxItems;
    }

    for (const item of input.startUrls) {
        const startUrl = item.url;

        if (checkLimit()) {
            break;
        }

        if (startUrl.includes('https://shop.nordstrom.com/')) {
            if (startUrl.match(/\/\d+\//)) {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'item' } });
                detailsEnqueued++;
            } else {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'start' } });
            }
        }
    }

    const crawler = new Apify.CheerioCrawler({
        requestQueue,

        minConcurrency: 2,
        maxConcurrency: 5,
        maxRequestRetries: 1,
        handlePageTimeoutSecs: 60,

        handlePageFunction: async ({ request, body, $ }) => {
            await delay(1000);
            console.log(`Processing ${request.url}...`);

            if (request.userData.label === 'start') {
                const total = $('._2Frdy._3gp2P').text().split(' ')[0].trim();
                const itemLinks = $('._1AOd3.QIjwE ._5lXiG');
                if (itemLinks.length === 0) {
                    return;
                }

                for (let index = 0; index < itemLinks.length; index++) {
                    if (checkLimit()) {
                        break;
                    }

                    const itemUrl = 'https://shop.nordstrom.com' + $(itemLinks[index]).attr('href');
                    if (itemUrl) {
                        await requestQueue.addRequest({ url: `${itemUrl}`, userData: { label: 'item' } });
                        detailsEnqueued++;
                    }
                }

                const link = 'https://shop.nordstrom.com/c/booties?origin=topnav&breadcrumb=Home%2FWomen%2FShoes%2FBooties&offset=2&page=2';

                await requestQueue.addRequest({ url: link, userData: { label: 'list' } });
            } else if (request.userData.label === 'list') {
                const itemLinks = $('._1AOd3.QIjwE ._5lXiG');
                if (itemLinks.length === 0) {
                    return;
                }
                
                for (let index = 0; index < itemLinks.length; index++) {
                    if (checkLimit()) {
                        break;
                    }

                    const itemUrl = 'https://shop.nordstrom.com' + $(itemLinks[index]).attr('href');
                    if (itemUrl) {
                        await requestQueue.addRequest({ url: `${itemUrl}`, userData: { label: 'item' } });
                        detailsEnqueued++;
                    }
                }

            } else if (request.userData.label === 'item') {
                // Extract json in javascript <script>window.__INITIAL_CONFIG__ = {}</script>
                const javascriptStr = body.match(/__\s=\s\{.*?\}\s*</s)[0].replace('__ =', '').trim().slice(0, -1);
                const json = safeEval(javascriptStr);

                const itemId = json.viewData.id;
                const name = json.viewData.productName;
                const description = json.viewData.description;

                const colorMap = json.viewData.filters.color.byId;
                const sizeMap = json.viewData.filters.size.byId;

                const sizes = [];
                let color = '';
                let price = '';
                
                for (const sku of Object.values(json.viewData.skus.byId)) {
                    const size = sizeMap[`${sku.sizeId}`].displayValue;
                    sizes.push(size);
                    color = colorMap[`${sku.colorId}`].displayValue;
                    price = sku.price;
                }

                const pageResult = {
                    url: request.url,
                    name,
                    description,
                    itemId,
                    color,
                    sizes,
                    price,
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                };

                if (extendOutputFunction) {
                    const userResult = await extendOutputFunction($);

                    if (!isObject(userResult)) {
                        console.log('extendOutputFunction has to return an object!!!');
                        process.exit(1);
                    }

                    _.extend(pageResult, userResult);
                }

                await Apify.pushData(pageResult);
            }
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed twice.`);
        },

        ...input.proxyConfiguration,
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
