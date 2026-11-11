'use strict';

/**
 * US bank directory used for the searchable bank selector.
 *
 * Routing numbers here are published ABA numbers used for demonstration of the
 * selector and lookup flow. In production this list should be replaced by a
 * licensed bank-directory feed (configured through BANK_DIRECTORY_API_URL).
 */

const BANKS = [
  { name: 'Bank of America, N.A.', shortName: 'Bank of America', routingNumber: '026009593' },
  { name: 'JPMorgan Chase Bank, N.A.', shortName: 'Chase', routingNumber: '021000021' },
  { name: 'Wells Fargo Bank, N.A.', shortName: 'Wells Fargo', routingNumber: '121000248' },
  { name: 'Citibank, N.A.', shortName: 'Citibank', routingNumber: '021000089' },
  { name: 'U.S. Bank, N.A.', shortName: 'U.S. Bank', routingNumber: '091000022' },
  { name: 'PNC Bank, N.A.', shortName: 'PNC Bank', routingNumber: '043000096' },
  { name: 'Capital One, N.A.', shortName: 'Capital One', routingNumber: '051405515' },
  { name: 'TD Bank, N.A.', shortName: 'TD Bank', routingNumber: '031101169' },
  { name: 'Truist Bank', shortName: 'Truist', routingNumber: '053101121' },
  { name: 'Fifth Third Bank, N.A.', shortName: 'Fifth Third Bank', routingNumber: '042000314' },
  { name: 'Citizens Bank, N.A.', shortName: 'Citizens Bank', routingNumber: '011500120' },
  { name: 'KeyBank, N.A.', shortName: 'KeyBank', routingNumber: '041001039' },
  { name: 'Regions Bank', shortName: 'Regions', routingNumber: '062000019' },
  { name: 'M&T Bank', shortName: 'M&T Bank', routingNumber: '022000046' },
  { name: 'BMO Bank, N.A.', shortName: 'BMO', routingNumber: '071000288' },
  { name: 'Huntington National Bank', shortName: 'Huntington', routingNumber: '044000024' },
  { name: 'Ally Bank', shortName: 'Ally Bank', routingNumber: '124003116' },
  { name: 'Charles Schwab Bank, SSB', shortName: 'Charles Schwab', routingNumber: '121202211' },
  { name: 'Navy Federal Credit Union', shortName: 'Navy Federal', routingNumber: '256074974' },
  { name: 'USAA Federal Savings Bank', shortName: 'USAA', routingNumber: '314074269' },
  { name: 'Goldman Sachs Bank USA', shortName: 'Goldman Sachs', routingNumber: '124085066' },
  { name: 'HSBC Bank USA, N.A.', shortName: 'HSBC', routingNumber: '021001088' },
  { name: 'Discover Bank', shortName: 'Discover', routingNumber: '031100649' },
  { name: 'American Express National Bank', shortName: 'American Express', routingNumber: '124276113' },
  { name: 'SoFi Bank, N.A.', shortName: 'SoFi', routingNumber: '121145307' },
  { name: 'Synchrony Bank', shortName: 'Synchrony', routingNumber: '021213591' },
  { name: 'Comerica Bank', shortName: 'Comerica', routingNumber: '072000096' },
  { name: 'Zions Bancorporation, N.A.', shortName: 'Zions Bank', routingNumber: '124000054' },
  { name: 'Valley National Bank', shortName: 'Valley Bank', routingNumber: '021201383' },
  { name: 'Webster Bank, N.A.', shortName: 'Webster Bank', routingNumber: '011501307' },
  { name: 'Santander Bank, N.A.', shortName: 'Santander', routingNumber: '011075150' },
  { name: 'BOKF, N.A.', shortName: 'BOK Financial', routingNumber: '103900036' },
  { name: 'Associated Bank, N.A.', shortName: 'Associated Bank', routingNumber: '075900575' },
  { name: 'Old National Bank', shortName: 'Old National', routingNumber: '086300012' },
  { name: 'First Horizon Bank', shortName: 'First Horizon', routingNumber: '084000026' },
  { name: 'SouthState Bank, N.A.', shortName: 'SouthState', routingNumber: '053201887' },
  { name: 'Western Alliance Bank', shortName: 'Western Alliance', routingNumber: '122105184' },
  { name: 'East West Bank', shortName: 'East West Bank', routingNumber: '322070381' },
  { name: 'Cathay Bank', shortName: 'Cathay Bank', routingNumber: '122203950' },
  { name: 'City National Bank', shortName: 'City National', routingNumber: '122016066' },
  { name: 'Axos Bank', shortName: 'Axos', routingNumber: '122287251' },
  { name: 'nbkc bank', shortName: 'nbkc', routingNumber: '101206400' },
  { name: 'Lead Bank', shortName: 'Lead Bank', routingNumber: '101019084' },
  { name: 'Live Oak Bank', shortName: 'Live Oak Bank', routingNumber: '053112592' },
  { name: 'Cross River Bank', shortName: 'Cross River', routingNumber: '021214891' },
  { name: 'Evolve Bank & Trust', shortName: 'Evolve Bank', routingNumber: '084106768' },
  { name: 'Sutton Bank', shortName: 'Sutton Bank', routingNumber: '041215663' },
  { name: 'Pathward, N.A.', shortName: 'Pathward', routingNumber: '091408501' },
  { name: 'Green Dot Bank', shortName: 'Green Dot', routingNumber: '124303120' },
  { name: 'Wintrust Bank, N.A.', shortName: 'Wintrust', routingNumber: '071921891' },
  { name: 'Northern Trust Company', shortName: 'Northern Trust', routingNumber: '071000152' },
  { name: 'First-Citizens Bank & Trust Company', shortName: 'First Citizens', routingNumber: '053100300' },
  { name: 'Fidelity Investments (UMB Bank)', shortName: 'Fidelity', routingNumber: '101205681' },
  { name: 'Vanguard (JPMorgan Chase)', shortName: 'Vanguard', routingNumber: '021000021' },
];

const DIRECTORY = BANKS.map((bank, index) => ({
  id: `bank_${String(index + 1).padStart(3, '0')}`,
  name: bank.name,
  shortName: bank.shortName,
  routingNumber: bank.routingNumber,
}));

function searchBanks(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const bank of DIRECTORY) {
    const name = bank.name.toLowerCase();
    const short = bank.shortName.toLowerCase();
    let score = -1;
    if (short.startsWith(q) || name.startsWith(q)) score = 3;
    else if (short.split(/[\s,&.]+/).some((w) => w.startsWith(q))) score = 2;
    else if (short.includes(q) || name.includes(q)) score = 1;
    if (score >= 0) scored.push({ score, bank });
  }
  scored.sort((a, b) => b.score - a.score || a.bank.shortName.localeCompare(b.bank.shortName));
  return scored.slice(0, limit).map((entry) => entry.bank);
}

function findBankById(id) {
  return DIRECTORY.find((bank) => bank.id === id) || null;
}

function findBankByRouting(routingNumber) {
  const clean = String(routingNumber || '').replace(/\D/g, '');
  return DIRECTORY.find((bank) => bank.routingNumber === clean) || null;
}

module.exports = { DIRECTORY, searchBanks, findBankById, findBankByRouting };
