'use strict';

const express = require('express');

const { requireAuth } = require('../services/sessions');
const { publicControls } = require('../services/system');

const router = express.Router();

/** Signed-in customers read the current money-movement availability. */
router.get('/controls', requireAuth, (req, res) => {
  res.json({ controls: publicControls() });
});

module.exports = router;
