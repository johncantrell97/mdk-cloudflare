import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setLogLevel, log } from './log.js'

describe('log', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setLogLevel('info') // reset to default
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  describe('default level (info)', () => {
    it('hides debug messages', () => {
      log.debug('hidden')
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('shows info messages', () => {
      log.info('visible')
      expect(logSpy).toHaveBeenCalledWith('visible')
    })

    it('shows warn messages', () => {
      log.warn('warning')
      expect(warnSpy).toHaveBeenCalledWith('warning')
    })

    it('shows error messages', () => {
      log.error('error')
      expect(errorSpy).toHaveBeenCalledWith('error')
    })
  })

  describe('debug level', () => {
    it('shows debug messages', () => {
      setLogLevel('debug')
      log.debug('debug msg')
      expect(logSpy).toHaveBeenCalledWith('debug msg')
    })

    it('shows info messages', () => {
      setLogLevel('debug')
      log.info('info msg')
      expect(logSpy).toHaveBeenCalledWith('info msg')
    })
  })

  describe('warn level', () => {
    it('hides debug and info messages', () => {
      setLogLevel('warn')
      log.debug('hidden')
      log.info('hidden')
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('shows warn messages', () => {
      setLogLevel('warn')
      log.warn('warning')
      expect(warnSpy).toHaveBeenCalledWith('warning')
    })

    it('shows error messages', () => {
      setLogLevel('warn')
      log.error('err')
      expect(errorSpy).toHaveBeenCalledWith('err')
    })
  })

  describe('error level', () => {
    it('hides debug, info, and warn messages', () => {
      setLogLevel('error')
      log.debug('hidden')
      log.info('hidden')
      log.warn('hidden')
      expect(logSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('shows error messages', () => {
      setLogLevel('error')
      log.error('critical')
      expect(errorSpy).toHaveBeenCalledWith('critical')
    })
  })

  describe('none level', () => {
    it('hides all messages', () => {
      setLogLevel('none')
      log.debug('hidden')
      log.info('hidden')
      log.warn('hidden')
      log.error('hidden')
      expect(logSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })
})
