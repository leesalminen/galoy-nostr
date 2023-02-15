import 'websocket-polyfill'
import {signId, calculateId, getPublicKey} from 'nostr'
import pkg from 'nostr-tools';
const {relayInit} = pkg
import lnService from 'ln-service'
import Redis from "ioredis"

const connectionObj = {
  sentinelPassword: process.env.REDIS_PASSWORD,
  sentinels: [
    {
      host: `${process.env.REDIS_0_DNS}`,
      port: process.env.REDIS_0_SENTINEL_PORT || 26379,
    },
    {
      host: `${process.env.REDIS_1_DNS}`,
      port: process.env.REDIS_1_SENTINEL_PORT || 26379,
    },
    {
      host: `${process.env.REDIS_2_DNS}`,
      port: process.env.REDIS_2_SENTINEL_PORT || 26379,
    },
  ],
  name: process.env.REDIS_MASTER_NAME ?? "mymaster",
  password: process.env.REDIS_PASSWORD,
}

const redis = new Redis(connectionObj)

function relay_send(ev, url, opts) {
  return new Promise(async (resolve, reject) => {
    const relay = relayInit(url)
    await relay.connect()

    let pub = relay.publish(ev)

    pub.on('ok', () => {
      console.log(`${relay.url} has accepted our event`)
      resolve(true)
    })
    pub.on('failed', reason => {
      console.log(`failed to publish to ${relay.url}: ${reason}`)
      reject(new Error(reason))
    })
    pub.on('seen', () => {
      console.log(`we saw the event on ${relay.url}`)
      resolve(true)
    })

    relay.on('connect', () => {
      console.log(`connected to ${relay.url}`)
    })
  })
}

async function send_note(urls, {privkey, pubkey}, ev)
{
  try {
    const tasks = urls.map(relay_send.bind(null, ev))
    await Promise.all(tasks)
  } catch (e) {
    //log?
    console.log(e)
  }
}

function get_zapreq(desc) {
  if (!desc)
    return null

  if (desc.kind === 9734)
    return desc

  // TODO: handle private zaps

  return null
}

async function process_invoice_payment(privkey, invoice)
{
  const pubkey = getPublicKey(privkey)
  const keypair = {privkey, pubkey}
  // Parse the invoice metadata
  let desc
  try {
    const rawDesc = await redis.get(`nostrInvoice:${invoice.id}`)

    if(rawDesc) {
      desc = JSON.parse(rawDesc)
    }
    
  } catch {
    //log(`Could not parse description as json`)
    return
  }
  if (!desc) {
    //log(`Could not parse metadata description as json for ${label}`)
    return
  }
  // Get the nostr note entry in the metadata
  const zapreq = get_zapreq(desc)
  if (!zapreq) {
    console.log(`Could not find zap request note in metadata`)
    return
  }

  // Make sure there are tags on the note
  if (!zapreq.tags || zapreq.tags.length === 0) {
    console.log(`No tags found`)
    return
  }
  // Make sure we only have one p tag
  const ptags = zapreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "p")
  if (ptags.length !== 1) {
    console.log(`None or multiple p tags found`)
    return
  }
  // Make sure we have 0 or 1 etag (for note zapping)
  const etags = zapreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "e")
  if (!(etags.length === 0 || etags.length === 1)) {
    console.log(`Expected none or 1 e tags`)
    return
  }
  // Look for the relays tag, we will broadcast to these relays
  const relays_tag = zapreq.tags.find(t => t && t.length && t.length >= 2 && t[0] === "relays")
  if (!relays_tag) {
    console.log(`No relays tag found in`)
    return
  }

  const relays = relays_tag.slice(1)
  const ptag = ptags[0]
  const etag = etags.length > 0 && etags[0]
  const data = {ptag, zapreq, invoice, keypair, ptag, etag, desc}
  const zap_note = await make_zap_note(data)
  console.log(`Sending lightning zap note ${zap_note.id} to ${relays.join(", ")}`)
  await send_note(relays, keypair, zap_note)
  console.log(`done`)
}

async function make_zap_note({keypair, invoice, zapreq, ptag, etag, desc}) {
  const kind = 9735
  const created_at = new Date(invoice.confirmed_at) / 1000
  const pubkey = keypair.pubkey
  const privkey = keypair.privkey
  const content = zapreq.content

  let tags = [ ptag ]
  if (etag)
    tags.push(etag)

  tags.push(["bolt11", invoice.request])
  tags.push(["description", JSON.stringify(desc)])
  tags.push(["preimage", invoice.secret])

  let ev = {pubkey, kind, created_at, content, tags}

  ev.id = await calculateId(ev)
  ev.sig = await signId(privkey, ev.id)

  return ev
}

async function run_zapper(args) {
  const privkey = process.env.NOSTR_PRIVATE_KEY
  if (!privkey) {
    console.log("set NOSTR_PRIVATE_KEY")
    return
  }

  const {lnd} = lnService.authenticatedLndGrpc({
    cert: process.env.LND1_TLS,
    macaroon: process.env.LND1_MACAROON,
    socket: `${process.env.LND1_DNS}:10009`,
  })

  const sub = lnService.subscribeToInvoices({lnd})

  sub.on("invoice_updated", async (invoice) => {
    if (!invoice.is_confirmed) {
      return
    }

    try {
      await process_invoice_payment(privkey, invoice)
      return
    } catch(e) {
      console.log("process threw an error", e)
      return
    }
  })
}

(async () => {
  run_zapper()
})()