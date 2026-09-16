/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { PlayCircle, Plus, Rss, Radio, Podcast, Loader2, Link2, ListPlus, Pause, SkipForward, Play, X, Zap } from 'lucide-react';

interface Episode {
  id: string;
  title: string;
  description: string;
  audioUrl: string;
  date: string;
}

export default function App() {
  const [rssUrl, setRssUrl] = useState('https://g1.globo.com/rss/g1/');
  const [savedSources, setSavedSources] = useState<string[]>([
    'https://g1.globo.com/rss/g1/',
    'https://ccm.artesp.sp.gov.br/rodovias/ocorrencias',
    'https://news.google.com/rss/search?q=mudan%C3%A7as+clim%C3%A1ticas+brasil&hl=pt-BR&gl=BR&ceid=BR:pt-419',
    'https://news.google.com.br'
  ]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [showQuotaPopup, setShowQuotaPopup] = useState(false);
  const [episodesGenerated, setEpisodesGenerated] = useState(0);
  
  // Continuous player state
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    fetchEpisodes();
  }, []);

  const fetchEpisodes = async () => {
    try {
      const res = await fetch('/api/episodes');
      const data = await res.json();
      setEpisodes(data);
    } catch (err) {
      console.error(err);
    }
  };

  const playSyntheticTransition = (type: 'in' | 'out' | 'time-in' | 'time-out') => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();

      if (type === 'in') {
        // Modern News Ping (Clean, authoritative double chime)
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc2.type = 'sine';

        osc1.frequency.setValueAtTime(880, ctx.currentTime);
        osc1.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
        
        osc2.frequency.setValueAtTime(1318.51, ctx.currentTime);
        osc2.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15);

        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(ctx.currentTime);
        osc2.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.8);
        osc2.stop(ctx.currentTime + 0.8);

      } else if (type === 'out') {
        // Modern Low Thud/Swoosh
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);

        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);

      } else if (type === 'time-in' || type === 'time-out') {
        // Mechanical Tick-Tock Sequence
        const createClick = (freq: number, time: number) => {
           const osc = ctx.createOscillator();
           const gain = ctx.createGain();
           
           osc.type = 'square';
           osc.frequency.setValueAtTime(freq, time);
           
           gain.gain.setValueAtTime(0, time);
           gain.gain.linearRampToValueAtTime(0.1, time + 0.002);
           gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);

           osc.connect(gain);
           gain.connect(ctx.destination);
           osc.start(time);
           osc.stop(time + 0.05);
        };

        const now = ctx.currentTime;
        createClick(1200, now);           // tick
        createClick(800, now + 0.5);      // tock
        if (type === 'time-in') {
          createClick(1200, now + 1.0);   // tick
        }
      }
    } catch (e) {
      console.error("Audio Context not supported", e);
    }
  };

  const generateTimeAnnouncement = async () => {
    try {
      const now = new Date();
      const timeString = `${now.getHours()} horas e ${now.getMinutes()} minutos`;
      const res = await fetch('/api/generate-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeString })
      });
      const data = await res.json();
      if (res.ok && !data.error) {
        setEpisodes(prev => [data, ...prev]);
        setCurrentPlayingIndex(curr => curr !== null ? curr + 1 : 0);
      }
    } catch (err) {
      console.error("Erro ao gerar anuncio de hora:", err);
    }
  };

  const handleAddSource = () => {
    if (rssUrl && !savedSources.includes(rssUrl)) {
      setSavedSources([...savedSources, rssUrl]);
    }
  };

  const handleRemoveSource = (sourceToRemove: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSavedSources(prev => prev.filter(s => s !== sourceToRemove));
  };

  const handleAutoGenerateAll = async () => {
    if (savedSources.length === 0) return;
    setIsGenerating(true);
    let genCount = episodesGenerated;
    try {
      for (const sourceUrl of savedSources) {
        const res = await fetch('/api/generate-episode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rssUrl: sourceUrl })
        });
        const data = await res.json();
        if (res.ok && !data.error) {
          setEpisodes(prev => [data, ...prev]);
          setCurrentPlayingIndex(curr => curr !== null ? curr + 1 : 0);
          
          genCount++;
          if (genCount % 3 === 0) {
            await generateTimeAnnouncement();
          }
        } else {
          if (data.error === "QUOTA_EXCEEDED") {
            setShowQuotaPopup(true);
            break; 
          }
        }
      }
      setEpisodesGenerated(genCount);
    } catch (err) {
      console.error(err);
      alert("Falha na geração em lote.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerate = async () => {
    if (!rssUrl) return;
    handleAddSource();
    setIsGenerating(true);
    try {
      const res = await fetch('/api/generate-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rssUrl })
      });
      const data = await res.json();
      if (res.ok && !data.error) {
        setEpisodes(prev => [data, ...prev]);
        setCurrentPlayingIndex(curr => curr !== null ? curr + 1 : 0);
        
        const newCount = episodesGenerated + 1;
        setEpisodesGenerated(newCount);
        if (newCount % 3 === 0) {
          await generateTimeAnnouncement();
        }
      } else {
        if (data.error === "QUOTA_EXCEEDED") {
          setShowQuotaPopup(true);
        } else {
          alert("Erro: " + (data.error || "Falha desconhecida"));
        }
      }
    } catch (err) {
      console.error(err);
      alert("Falha na geração do episódio.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Player controls
  useEffect(() => {
    if (currentPlayingIndex !== null && audioRef.current) {
      const currentEpisode = episodes[currentPlayingIndex];
      const isTime = currentEpisode?.title?.includes("Hora Certa");
      
      playSyntheticTransition(isTime ? 'time-in' : 'in');
      
      // Delay to let transition play
      setTimeout(() => {
         if (audioRef.current) {
            audioRef.current.play().catch(e => console.error("Audio play failed:", e));
            setIsPlaying(true);
         }
      }, isTime ? 1200 : 600);
    }
  }, [currentPlayingIndex]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(e => console.error(e));
    }
    setIsPlaying(!isPlaying);
  };

  const handleAudioEnded = () => {
    const currentEpisode = currentPlayingIndex !== null ? episodes[currentPlayingIndex] : null;
    const isTime = currentEpisode?.title?.includes("Hora Certa");
    
    playSyntheticTransition(isTime ? 'time-out' : 'out');
    
    // Play next episode in the list (older episodes since index 0 is newest)
    setTimeout(() => {
      if (currentPlayingIndex !== null && currentPlayingIndex < episodes.length - 1) {
        setCurrentPlayingIndex(currentPlayingIndex + 1);
      } else {
        setIsPlaying(false);
        setCurrentPlayingIndex(null);
      }
    }, isTime ? 700 : 500);
  };

  const playEpisode = (index: number) => {
    setCurrentPlayingIndex(index);
  };

  const currentEpisode = currentPlayingIndex !== null ? episodes[currentPlayingIndex] : null;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans pb-28">
      <div className="w-full max-w-7xl mx-auto px-2 sm:px-4 md:px-6 py-3 space-y-4">
        
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 pb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-neutral-900 text-white rounded-xl flex items-center justify-center shadow-md">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">AI Radio Studio</h1>
              <p className="text-xs sm:text-sm text-neutral-500">Automação de Podcast & Rádio ao Vivo</p>
            </div>
          </div>
          <a 
            href="/feed.xml" 
            target="_blank" 
            rel="noopener noreferrer"
            className="self-start sm:self-auto flex items-center gap-2 px-3.5 py-1.5 bg-orange-100 text-orange-700 text-sm font-medium rounded-lg hover:bg-orange-200 transition-colors shadow-sm"
          >
            <Rss className="w-4 h-4" />
            <span>Feed do Podcast (XML)</span>
          </a>
        </header>

        <main className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
          
          {/* Dashboard Left Column */}
          <div className="md:col-span-5 space-y-6">
            <section className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm">
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <Podcast className="w-5 h-5 text-neutral-500" />
                Gerador de Episódio
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">
                    Fonte de Dados (URL RSS ou ARTESP)
                  </label>
                  <div className="flex gap-2">
                    <input 
                      type="url"
                      value={rssUrl}
                      onChange={(e) => setRssUrl(e.target.value)}
                      className="flex-1 px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:outline-none"
                      placeholder="https://..."
                    />
                    <button 
                      onClick={handleAddSource}
                      className="p-2 border border-neutral-300 rounded-lg hover:bg-neutral-50 text-neutral-600 transition-colors"
                      title="Salvar Fonte na Lista"
                    >
                      <ListPlus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                
                <button 
                  onClick={handleGenerate}
                  disabled={isGenerating || !rssUrl}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-neutral-900 text-white font-medium rounded-lg hover:bg-neutral-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Gerando Roteiro e Áudio...
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5" />
                      Gerar Episódio Agora
                    </>
                  )}
                </button>
              </div>
            </section>

            {/* Saved Sources */}
            <section className="bg-white p-6 rounded-2xl border border-neutral-200 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold flex items-center gap-2 text-neutral-700">
                  <Link2 className="w-4 h-4 text-neutral-400" />
                  Fontes Salvas
                </h2>
                <button 
                  onClick={handleAutoGenerateAll}
                  disabled={isGenerating || savedSources.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-900 text-white text-xs font-medium rounded-lg hover:bg-neutral-800 transition-colors disabled:opacity-50"
                  title="Gerar automaticamente áudio de todas as fontes salvas"
                >
                  {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-yellow-400" />}
                  Auto Gerar Tudo
                </button>
              </div>
              <ul className="space-y-2">
                {savedSources.map((source, idx) => (
                  <li key={idx} className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
                    rssUrl === source 
                      ? 'bg-neutral-100' 
                      : 'hover:bg-neutral-50'
                  }`}>
                    <button 
                      onClick={() => setRssUrl(source)}
                      className={`flex-1 text-left text-sm truncate ${
                        rssUrl === source 
                          ? 'text-neutral-900 font-medium' 
                          : 'text-neutral-500 hover:text-neutral-700'
                      }`}
                    >
                      {source}
                    </button>
                    <button 
                      onClick={(e) => handleRemoveSource(source, e)}
                      className="flex-shrink-0 p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                      title="Remover fonte"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* Dashboard Right Column */}
          <div className="md:col-span-7 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <PlayCircle className="w-5 h-5 text-neutral-500" />
                Playlist de Transmissão
              </h2>
              <span className="text-xs font-medium px-2 py-1 bg-green-100 text-green-700 rounded-full flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                Autoplay Ativo
              </span>
            </div>

            {episodes.length === 0 ? (
              <div className="bg-white p-8 rounded-2xl border border-neutral-200 border-dashed text-center">
                <p className="text-neutral-500">Nenhum episódio gerado ainda.</p>
                <p className="text-sm text-neutral-400 mt-1">Gere um episódio para ouvir aqui e popular o seu Feed RSS.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {episodes.map((ep, index) => {
                  const isPlayingThis = currentPlayingIndex === index;
                  return (
                    <article 
                      key={ep.id} 
                      className={`p-4 rounded-xl border transition-all ${
                        isPlayingThis 
                          ? 'bg-neutral-900 border-neutral-900 text-white shadow-md' 
                          : 'bg-white border-neutral-200 shadow-sm hover:border-neutral-300'
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        <button 
                          onClick={() => playEpisode(index)}
                          className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                            isPlayingThis 
                              ? 'bg-white text-neutral-900' 
                              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900'
                          }`}
                        >
                          {isPlayingThis && isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-1" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <h3 className={`font-semibold truncate ${isPlayingThis ? 'text-white' : 'text-neutral-900'}`}>
                            {ep.title}
                          </h3>
                          <p className={`text-xs mt-1 truncate ${isPlayingThis ? 'text-neutral-300' : 'text-neutral-400'}`}>
                            {new Date(ep.date).toLocaleString('pt-BR')}
                          </p>
                        </div>
                      </div>
                      
                      {!isPlayingThis && (
                        <details className="mt-3 text-sm text-neutral-600 group">
                          <summary className="cursor-pointer font-medium hover:text-neutral-900 pl-14">
                            Ver roteiro
                          </summary>
                          <div className="mt-2 p-3 bg-neutral-50 rounded-lg border border-neutral-100 whitespace-pre-wrap leading-relaxed ml-14">
                            {ep.description}
                          </div>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Global Audio Element */}
      <audio 
        ref={audioRef}
        src={currentEpisode?.audioUrl}
        onEnded={handleAudioEnded}
        className="hidden"
      />

      {/* Floating Player UI */}
      {currentEpisode && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] p-3 sm:p-4 transform transition-transform">
          <div className="max-w-7xl mx-auto px-2 sm:px-4 md:px-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <div className="w-12 h-12 bg-neutral-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <Radio className="w-6 h-6 text-neutral-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-0.5">Tocando Agora</p>
                <p className="font-semibold text-neutral-900 truncate">{currentEpisode.title}</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <button 
                onClick={togglePlay}
                className="w-12 h-12 bg-neutral-900 text-white rounded-full flex items-center justify-center hover:bg-neutral-800 transition-transform hover:scale-105 active:scale-95"
              >
                {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-1" />}
              </button>
              <button 
                onClick={handleAudioEnded}
                className="w-10 h-10 text-neutral-400 hover:text-neutral-900 rounded-full flex items-center justify-center hover:bg-neutral-100 transition-colors"
                title="Pular para o próximo"
              >
                <SkipForward className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quota Exceeded Popup */}
      {showQuotaPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-4">
              <Zap className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-neutral-900 mb-2">Limite da API Excedido</h3>
            <p className="text-neutral-600 mb-6 leading-relaxed">
              Você atingiu o limite gratuito de requisições da API do Google Gemini. Aguarde alguns minutos antes de tentar gerar novos episódios ou atualize seu plano na plataforma do Google AI Studio.
            </p>
            <div className="flex justify-end">
              <button 
                onClick={() => setShowQuotaPopup(false)}
                className="px-5 py-2.5 bg-neutral-900 text-white font-medium rounded-lg hover:bg-neutral-800 transition-colors"
              >
                Entendi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
