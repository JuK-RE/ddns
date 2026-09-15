import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

export default app
