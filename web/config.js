/*
 * The ONE value set at deploy time: the endpoint web app URL (it ends in /exec).
 * Get it from the endpoint project: Deploy -> Manage deployments -> Web app URL.
 * This URL is public by nature (every guest's browser calls it), so it is
 * fine to commit it. Nothing else private belongs in this repo.
 */
var ENDPOINT_URL = 'PASTE_ENDPOINT_URL_HERE';
